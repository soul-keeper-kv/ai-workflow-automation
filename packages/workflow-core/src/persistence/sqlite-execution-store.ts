import type { ExecutionStatus } from '@aap/shared';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import {
  ConcurrentModificationError,
  CorruptRecordError,
  ExecutionNotFoundError,
  PayloadTooLargeError,
} from '../contracts/errors.js';
import type { JsonValue } from '../contracts/json.js';
import { assertStatusTransition, isTerminalStatus } from '../execution/status.js';
import type { WorkflowDb } from './database.js';
import type {
  ErrorInfo,
  ExecutionChange,
  ExecutionEventRecord,
  ExecutionRecord,
  ExecutionStore,
  NewExecution,
  StepRunRecord,
} from './execution-store.js';
import { workflowEvents, workflowExecutions, workflowStepExecutions } from './schema.js';

export interface StorageLimits {
  /** Input, context, output and step results. Large artifacts belong in files, not here. */
  jsonBytes: number;
  eventPayloadBytes: number;
  errorMessageChars: number;
}

export const DEFAULT_STORAGE_LIMITS: StorageLimits = {
  jsonBytes: 1024 * 1024,
  eventPayloadBytes: 64 * 1024,
  errorMessageChars: 2_000,
};

type ExecutionRow = typeof workflowExecutions.$inferSelect;
type StepRunRow = typeof workflowStepExecutions.$inferSelect;
type EventRow = typeof workflowEvents.$inferSelect;
type EventInsert = typeof workflowEvents.$inferInsert;

export interface SqliteExecutionStoreOptions {
  clock?: () => Date;
  limits?: Partial<StorageLimits>;
}

export class SqliteExecutionStore implements ExecutionStore {
  readonly #db: WorkflowDb;
  readonly #clock: () => Date;
  readonly #limits: StorageLimits;

  constructor(db: WorkflowDb, options: SqliteExecutionStoreOptions = {}) {
    this.#db = db;
    this.#clock = options.clock ?? (() => new Date());
    this.#limits = { ...DEFAULT_STORAGE_LIMITS, ...options.limits };
  }

  createExecution(execution: NewExecution): ExecutionRecord {
    const at = this.#clock();
    const row: ExecutionRow = {
      id: execution.id,
      workflowId: execution.workflowId,
      workflowVersion: execution.workflowVersion,
      status: 'PENDING',
      currentState: execution.currentState,
      inputJson: this.#serialize(execution.input, 'input', this.#limits.jsonBytes),
      contextJson: this.#serialize(execution.context, 'context', this.#limits.jsonBytes),
      outputJson: null,
      errorCode: null,
      errorMessage: null,
      revision: 0,
      createdAt: at,
      startedAt: null,
      updatedAt: at,
      completedAt: null,
    };

    this.#db.transaction(
      (tx) => {
        tx.insert(workflowExecutions).values(row).run();
        tx.insert(workflowEvents)
          .values({
            executionId: row.id,
            eventType: 'EXECUTION_CREATED',
            stateAfter: row.currentState,
            payloadJson: this.#serialize(
              { workflowId: row.workflowId, workflowVersion: row.workflowVersion },
              'event payload',
              this.#limits.eventPayloadBytes,
            ),
            createdAt: at,
          })
          .run();
      },
      { behavior: 'immediate' },
    );

    return this.#toExecution(row);
  }

  applyChange(change: ExecutionChange): ExecutionRecord {
    const at = this.#clock();
    const patch = change.execution ?? {};

    return this.#db.transaction(
      (tx) => {
        const current = tx
          .select()
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, change.executionId))
          .get();
        if (current === undefined) throw new ExecutionNotFoundError(change.executionId);
        if (current.revision !== change.expectedRevision) {
          throw new ConcurrentModificationError(
            change.executionId,
            change.expectedRevision,
            current.revision,
          );
        }

        const events: EventInsert[] = (change.events ?? []).map((event) => ({
          executionId: change.executionId,
          eventType: event.type,
          stateBefore: event.stateBefore ?? null,
          stateAfter: event.stateAfter ?? null,
          payloadJson:
            event.payload === undefined
              ? null
              : this.#serialize(event.payload, 'event payload', this.#limits.eventPayloadBytes),
          createdAt: at,
        }));

        const update: Partial<ExecutionRow> = { revision: current.revision + 1, updatedAt: at };
        const status = patch.status;
        if (status !== undefined && status !== current.status) {
          assertStatusTransition(current.status, status);
          update.status = status;
          if (status === 'RUNNING' && current.startedAt === null) update.startedAt = at;
          if (isTerminalStatus(status)) update.completedAt = at;
          events.push({
            executionId: change.executionId,
            eventType: 'STATUS_CHANGED',
            stateBefore: current.currentState,
            stateAfter: patch.currentState ?? current.currentState,
            payloadJson: JSON.stringify({ from: current.status, to: status }),
            createdAt: at,
          });
        }
        if (patch.currentState !== undefined) update.currentState = patch.currentState;
        if (patch.context !== undefined) {
          update.contextJson = this.#serialize(patch.context, 'context', this.#limits.jsonBytes);
        }
        if (patch.output !== undefined) {
          update.outputJson =
            patch.output === null
              ? null
              : this.#serialize(patch.output, 'output', this.#limits.jsonBytes);
        }
        if (patch.error !== undefined) {
          update.errorCode = patch.error?.code ?? null;
          update.errorMessage = patch.error === null ? null : this.#truncate(patch.error.message);
        }

        const updated = tx
          .update(workflowExecutions)
          .set(update)
          .where(
            and(
              eq(workflowExecutions.id, change.executionId),
              eq(workflowExecutions.revision, change.expectedRevision),
            ),
          )
          .run();
        if (updated.changes !== 1) {
          throw new ConcurrentModificationError(
            change.executionId,
            change.expectedRevision,
            current.revision,
          );
        }

        if (change.startStepRun !== undefined) {
          tx.insert(workflowStepExecutions)
            .values({
              id: change.startStepRun.id,
              executionId: change.executionId,
              stepId: change.startStepRun.stepId,
              status: 'RUNNING',
              attempt: change.startStepRun.attempt,
              startedAt: at,
            })
            .run();
        }

        const finish = change.finishStepRun;
        if (finish !== undefined) {
          const finished = tx
            .update(workflowStepExecutions)
            .set({
              status: finish.status,
              outputJson:
                finish.output === undefined
                  ? null
                  : this.#serialize(finish.output, 'step output', this.#limits.jsonBytes),
              errorCode: finish.error?.code ?? null,
              errorMessage:
                finish.error === undefined ? null : this.#truncate(finish.error.message),
              completedAt: at,
            })
            .where(
              and(
                eq(workflowStepExecutions.id, finish.id),
                eq(workflowStepExecutions.executionId, change.executionId),
                eq(workflowStepExecutions.status, 'RUNNING'),
              ),
            )
            .run();
          if (finished.changes !== 1) {
            throw new CorruptRecordError(
              `Step run ${finish.id} of execution ${change.executionId} is not running.`,
            );
          }
        }

        if (events.length > 0) tx.insert(workflowEvents).values(events).run();

        const row = tx
          .select()
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, change.executionId))
          .get();
        if (row === undefined) throw new ExecutionNotFoundError(change.executionId);
        return this.#toExecution(row);
      },
      { behavior: 'immediate' },
    );
  }

  getExecution(id: string): ExecutionRecord | undefined {
    const row = this.#db
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, id))
      .get();
    return row === undefined ? undefined : this.#toExecution(row);
  }

  listExecutionsByStatus(statuses: readonly ExecutionStatus[]): ExecutionRecord[] {
    if (statuses.length === 0) return [];
    return this.#db
      .select()
      .from(workflowExecutions)
      .where(inArray(workflowExecutions.status, [...statuses]))
      .orderBy(asc(workflowExecutions.createdAt), sql`rowid`)
      .all()
      .map((row) => this.#toExecution(row));
  }

  getRunningStepRun(executionId: string): StepRunRecord | undefined {
    const row = this.#db
      .select()
      .from(workflowStepExecutions)
      .where(
        and(
          eq(workflowStepExecutions.executionId, executionId),
          eq(workflowStepExecutions.status, 'RUNNING'),
        ),
      )
      .get();
    return row === undefined ? undefined : this.#toStepRun(row);
  }

  countStepRuns(executionId: string, stepId: string): number {
    const row = this.#db
      .select({ n: count() })
      .from(workflowStepExecutions)
      .where(
        and(
          eq(workflowStepExecutions.executionId, executionId),
          eq(workflowStepExecutions.stepId, stepId),
        ),
      )
      .get();
    return row?.n ?? 0;
  }

  listStepRuns(executionId: string): StepRunRecord[] {
    return this.#db
      .select()
      .from(workflowStepExecutions)
      .where(eq(workflowStepExecutions.executionId, executionId))
      .orderBy(asc(workflowStepExecutions.startedAt), sql`rowid`)
      .all()
      .map((row) => this.#toStepRun(row));
  }

  listEvents(executionId: string): ExecutionEventRecord[] {
    return this.#db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.executionId, executionId))
      .orderBy(asc(workflowEvents.id))
      .all()
      .map((row) => this.#toEvent(row));
  }

  #serialize(value: JsonValue, field: string, limit: number): string {
    const text = JSON.stringify(value);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > limit) throw new PayloadTooLargeError(field, bytes, limit);
    return text;
  }

  #parse(text: string | null, field: string, owner: string): unknown {
    if (text === null) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new CorruptRecordError(`${field} of ${owner} is not valid JSON.`, { cause });
    }
  }

  #truncate(message: string): string {
    const max = this.#limits.errorMessageChars;
    return message.length <= max ? message : `${message.slice(0, max - 1)}…`;
  }

  #error(code: string | null, message: string | null): ErrorInfo | null {
    return code === null ? null : { code, message: message ?? '' };
  }

  #toExecution(row: ExecutionRow): ExecutionRecord {
    const owner = `execution ${row.id}`;
    return {
      id: row.id,
      workflowId: row.workflowId,
      workflowVersion: row.workflowVersion,
      status: row.status,
      currentState: row.currentState,
      input: this.#parse(row.inputJson, 'input', owner),
      context: this.#parse(row.contextJson, 'context', owner),
      output: this.#parse(row.outputJson, 'output', owner),
      error: this.#error(row.errorCode, row.errorMessage),
      revision: row.revision,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt,
    };
  }

  #toStepRun(row: StepRunRow): StepRunRecord {
    return {
      id: row.id,
      executionId: row.executionId,
      stepId: row.stepId,
      status: row.status,
      attempt: row.attempt,
      output: this.#parse(row.outputJson, 'output', `step run ${row.id}`),
      error: this.#error(row.errorCode, row.errorMessage),
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    };
  }

  #toEvent(row: EventRow): ExecutionEventRecord {
    return {
      id: row.id,
      executionId: row.executionId,
      type: row.eventType,
      stateBefore: row.stateBefore,
      stateAfter: row.stateAfter,
      payload: this.#parse(row.payloadJson, 'payload', `event ${row.id}`),
      createdAt: row.createdAt,
    };
  }
}
