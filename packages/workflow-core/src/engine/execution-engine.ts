import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  ENGINE_ERROR_CODES,
  ExecutionConflictError,
  ExecutionNotFoundError,
  WorkflowEngineError,
} from '../contracts/errors.js';
import { silentLogger, type Logger } from '../contracts/logger.js';
import type { StepOutcome, Workflow } from '../contracts/workflow.js';
import { isTerminalStatus } from '../execution/status.js';
import type {
  ErrorInfo,
  ExecutionRecord,
  ExecutionStore,
  NewExecutionEvent,
} from '../persistence/execution-store.js';
import { planRecovery } from '../recovery/plan-recovery.js';
import type { WorkflowRegistry } from '../registry/workflow-registry.js';

export interface ExecutionEngineOptions {
  registry: WorkflowRegistry;
  store: ExecutionStore;
  logger?: Logger;
  /** Executions that run at the same time. The rest wait in FIFO order. */
  maxConcurrentExecutions?: number;
  generateId?: () => string;
}

export interface StopOptions {
  /** How long running steps get to finish on their own. */
  drainTimeoutMs?: number;
  /** After aborting, how long to wait for steps to react before giving up. */
  abortTimeoutMs?: number;
}

export interface RecoveryReport {
  resumed: string[];
  interrupted: string[];
}

export interface CancelResult {
  /**
   * `cancelled`: the execution is CANCELLED now.
   * `requested`: a step is running; it was asked to stop, and the execution becomes CANCELLED
   * when it does.
   */
  outcome: 'cancelled' | 'requested';
  execution: ExecutionRecord;
}

/** The abort reason given to steps when the engine stops. */
export class EngineShutdownError extends Error {
  override readonly name = 'EngineShutdownError';

  constructor() {
    super('The workflow engine is shutting down.');
  }
}

/** The abort reason given to a step when the user cancels its execution. */
export class ExecutionCancelledError extends Error {
  override readonly name = 'ExecutionCancelledError';

  constructor() {
    super('The execution was cancelled.');
  }
}

interface ActiveExecution {
  controller: AbortController;
  done: Promise<void>;
}

const CANCELLED_WHILE_RUNNING: ErrorInfo = {
  code: ENGINE_ERROR_CODES.cancelled,
  message: 'Cancelled while this step was running.',
};

function errorInfo(error: unknown): ErrorInfo {
  if (error instanceof WorkflowEngineError) return { code: error.code, message: error.message };
  if (error instanceof Error)
    return { code: ENGINE_ERROR_CODES.stepFailed, message: error.message };
  return { code: ENGINE_ERROR_CODES.stepFailed, message: String(error) };
}

/**
 * Runs executions inside this process: one step at a time per execution, persisting every
 * step start and every transition before moving on. HTTP handlers call `start` or `cancel`
 * and return; the work happens here, outside the request.
 *
 * While a step runs, only that execution's run loop writes to it. Requests that arrive
 * meanwhile (cancel) set a flag and abort the step's signal; the loop records the outcome.
 */
export class ExecutionEngine {
  readonly #registry: WorkflowRegistry;
  readonly #store: ExecutionStore;
  readonly #log: Logger;
  readonly #maxConcurrent: number;
  readonly #generateId: () => string;

  readonly #queue: string[] = [];
  readonly #active = new Map<string, ActiveExecution>();
  readonly #cancelRequested = new Set<string>();
  readonly #idleWaiters: (() => void)[] = [];
  #stopping = false;

  constructor(options: ExecutionEngineOptions) {
    this.#registry = options.registry;
    this.#store = options.store;
    this.#log = options.logger ?? silentLogger;
    this.#maxConcurrent = Math.max(1, options.maxConcurrentExecutions ?? 2);
    this.#generateId = options.generateId ?? randomUUID;
  }

  /**
   * Validates input, persists a PENDING execution and schedules it. Returns without waiting
   * for any step. Throws WorkflowNotFoundError or InputValidationError.
   */
  start(workflowId: string, rawInput: unknown): ExecutionRecord {
    if (this.#stopping) {
      throw new WorkflowEngineError('ENGINE_STOPPING', 'The workflow engine is shutting down.');
    }
    const workflow = this.#registry.require(workflowId);
    const prepared = workflow.prepare(rawInput);
    const execution = this.#store.createExecution({
      id: this.#generateId(),
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      currentState: prepared.state,
      input: prepared.input,
      context: prepared.context,
    });
    this.#log.info(
      { executionId: execution.id, workflowId, eventType: 'EXECUTION_CREATED' },
      'Execution created',
    );
    this.#schedule(execution.id);
    return execution;
  }

  /**
   * Cancels cooperatively. No new step starts; a running step gets its signal aborted and the
   * execution becomes CANCELLED once the step settles. History is kept.
   * Throws ExecutionNotFoundError, or ExecutionConflictError for a finished execution.
   */
  cancel(executionId: string): CancelResult {
    const execution = this.#store.getExecution(executionId);
    if (execution === undefined) throw new ExecutionNotFoundError(executionId);
    if (isTerminalStatus(execution.status)) {
      throw new ExecutionConflictError(
        executionId,
        `The execution is already ${execution.status} and cannot be cancelled.`,
      );
    }

    const active = this.#active.get(executionId);
    if (active !== undefined) {
      if (!this.#cancelRequested.has(executionId)) {
        this.#cancelRequested.add(executionId);
        active.controller.abort(new ExecutionCancelledError());
        this.#log.info({ executionId, eventType: 'CANCEL_REQUESTED' }, 'Cancel requested');
      }
      return { outcome: 'requested', execution };
    }

    // Nothing runs for it in this process, so it can be cancelled right away.
    const queued = this.#queue.indexOf(executionId);
    if (queued >= 0) this.#queue.splice(queued, 1);
    const cancelled = this.#store.applyChange({
      executionId,
      expectedRevision: execution.revision,
      execution: { status: 'CANCELLED' },
      events: [{ type: 'CANCEL_REQUESTED', stateBefore: execution.currentState }],
    });
    this.#log.info({ executionId, eventType: 'CANCEL_REQUESTED' }, 'Execution cancelled');
    return { outcome: 'cancelled', execution: cancelled };
  }

  isCancelRequested(executionId: string): boolean {
    return this.#cancelRequested.has(executionId);
  }

  /** Call once at startup, before accepting work. See planRecovery for the rules. */
  recover(): RecoveryReport {
    const report: RecoveryReport = { resumed: [], interrupted: [] };
    for (const execution of this.#store.listExecutionsByStatus(['PENDING', 'RUNNING'])) {
      const runningStep = this.#store.getRunningStepRun(execution.id) ?? null;
      const plan = planRecovery(execution, runningStep);
      if (plan.action === 'resume') {
        this.#schedule(execution.id);
        report.resumed.push(execution.id);
      } else {
        this.#store.applyChange({
          executionId: execution.id,
          expectedRevision: execution.revision,
          execution: { status: 'INTERRUPTED', error: plan.error },
          ...(runningStep === null
            ? {}
            : {
                finishStepRun: { id: runningStep.id, status: 'INTERRUPTED', error: plan.error },
                events: [
                  {
                    type: 'STEP_INTERRUPTED',
                    stateBefore: runningStep.stepId,
                    payload: { stepRunId: runningStep.id, stepId: runningStep.stepId },
                  },
                ],
              }),
        });
        report.interrupted.push(execution.id);
      }
    }
    this.#log.info(
      { resumed: report.resumed.length, interrupted: report.interrupted.length },
      'Recovery finished',
    );
    return report;
  }

  /**
   * Stops scheduling, lets running steps finish for `drainTimeoutMs`, then aborts them.
   * A step that finishes during the drain commits normally, so its execution resumes on the
   * next start. A step that is aborted leaves its execution INTERRUPTED.
   */
  async stop(options: StopOptions = {}): Promise<void> {
    const { drainTimeoutMs = 5_000, abortTimeoutMs = 2_000 } = options;
    this.#stopping = true;
    this.#queue.length = 0;

    if (await this.#settleWithin(drainTimeoutMs)) return;

    this.#log.warn({ executionIds: [...this.#active.keys()] }, 'Aborting steps still running');
    for (const { controller } of this.#active.values()) controller.abort(new EngineShutdownError());

    if (!(await this.#settleWithin(abortTimeoutMs))) {
      this.#log.error(
        { executionIds: [...this.#active.keys()] },
        'Steps ignored the abort; they will be marked interrupted on the next start',
      );
    }
  }

  /** Resolves when nothing is running or queued. */
  whenIdle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  isActive(executionId: string): boolean {
    return this.#active.has(executionId) || this.#queue.includes(executionId);
  }

  #isIdle(): boolean {
    return this.#active.size === 0 && this.#queue.length === 0;
  }

  #schedule(executionId: string): void {
    if (this.#stopping || this.isActive(executionId)) return;
    this.#queue.push(executionId);
    this.#pump();
  }

  #pump(): void {
    while (!this.#stopping && this.#active.size < this.#maxConcurrent) {
      const executionId = this.#queue.shift();
      if (executionId === undefined) break;

      const controller = new AbortController();
      const done = this.#runExecution(executionId, controller.signal)
        .catch((error: unknown) => {
          this.#log.error({ executionId, err: error }, 'Execution loop stopped on an error');
        })
        .finally(() => {
          this.#active.delete(executionId);
          this.#cancelRequested.delete(executionId);
          this.#pump();
          if (this.#isIdle()) for (const resolve of this.#idleWaiters.splice(0)) resolve();
        });
      this.#active.set(executionId, { controller, done });
    }
  }

  async #settleWithin(timeoutMs: number): Promise<boolean> {
    if (this.#active.size === 0) return true;
    const all = Promise.allSettled([...this.#active.values()].map((active) => active.done));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([all.then(() => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #runExecution(executionId: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (this.#stopping) return;

      const execution = this.#store.getExecution(executionId);
      if (execution === undefined) return;
      if (execution.status !== 'PENDING' && execution.status !== 'RUNNING') return;

      if (this.#cancelRequested.has(executionId)) {
        this.#store.applyChange({
          executionId,
          expectedRevision: execution.revision,
          execution: { status: 'CANCELLED' },
          events: [{ type: 'CANCEL_REQUESTED', stateBefore: execution.currentState }],
        });
        return;
      }

      const workflow = this.#registry.get(execution.workflowId);
      if (workflow?.version !== execution.workflowVersion) {
        this.#store.applyChange({
          executionId,
          expectedRevision: execution.revision,
          execution: {
            status: 'INTERRUPTED',
            error: {
              code: ENGINE_ERROR_CODES.workflowUnavailable,
              message: `Workflow ${execution.workflowId}@${execution.workflowVersion} is not registered in this version of the app.`,
            },
          },
        });
        return;
      }

      const finished = await this.#runStep(workflow, execution, signal);
      if (finished) return;
    }
  }

  /** Runs the step of the execution's current state. Returns true when the loop must end. */
  async #runStep(
    workflow: Workflow,
    execution: ExecutionRecord,
    signal: AbortSignal,
  ): Promise<boolean> {
    const stepId = execution.currentState;
    const attempt = this.#store.countStepRuns(execution.id, stepId) + 1;
    const stepRunId = this.#generateId();
    const log = this.#log.child({
      executionId: execution.id,
      workflowId: workflow.id,
      stepId,
      attempt,
    });

    const started = this.#store.applyChange({
      executionId: execution.id,
      expectedRevision: execution.revision,
      execution: { status: 'RUNNING' },
      startStepRun: { id: stepRunId, stepId, attempt },
      events: [
        { type: 'STEP_STARTED', stateBefore: stepId, payload: { stepRunId, stepId, attempt } },
      ],
    });
    log.info({ eventType: 'STEP_STARTED' }, 'Step started');
    const startTime = performance.now();
    const elapsed = () => Math.round(performance.now() - startTime);
    const cancelEvent: NewExecutionEvent = { type: 'CANCEL_REQUESTED', stateBefore: stepId };

    let outcome: StepOutcome;
    try {
      outcome = await workflow.runStep({
        state: stepId,
        context: execution.context,
        executionId: execution.id,
        attempt,
        signal,
        log,
      });
    } catch (error) {
      const cancelled = this.#cancelRequested.has(execution.id);
      const interrupted = !cancelled && signal.aborted;
      const info: ErrorInfo = cancelled
        ? CANCELLED_WHILE_RUNNING
        : interrupted
          ? {
              code: ENGINE_ERROR_CODES.interrupted,
              message: `The app stopped while step "${stepId}" was running. It was not re-run, because it may already have had side effects.`,
            }
          : errorInfo(error);
      const stepEvent: NewExecutionEvent = {
        type: cancelled || interrupted ? 'STEP_INTERRUPTED' : 'STEP_FAILED',
        stateBefore: stepId,
        payload: { stepRunId, stepId, attempt, errorCode: info.code },
      };

      this.#store.applyChange({
        executionId: execution.id,
        expectedRevision: started.revision,
        execution: cancelled
          ? { status: 'CANCELLED' }
          : { status: interrupted ? 'INTERRUPTED' : 'FAILED', error: info },
        finishStepRun: {
          id: stepRunId,
          status: cancelled || interrupted ? 'INTERRUPTED' : 'FAILED',
          error: info,
        },
        events: cancelled ? [cancelEvent, stepEvent] : [stepEvent],
      });
      const result = cancelled ? 'cancelled' : interrupted ? 'interrupted' : 'failed';
      log[result === 'failed' ? 'error' : 'warn'](
        {
          eventType: stepEvent.type,
          durationMs: elapsed(),
          result,
          errorCode: info.code,
          ...(result === 'failed' ? { err: error } : {}),
        },
        `Step ${result}`,
      );
      return true;
    }

    // The step finished. If a cancel arrived meanwhile, keep its result and stop here,
    // unless it already reached a final state.
    const final = outcome.final;
    const cancelled = final === null && this.#cancelRequested.has(execution.id);
    this.#store.applyChange({
      executionId: execution.id,
      expectedRevision: started.revision,
      execution: {
        currentState: outcome.stateAfter,
        context: outcome.context,
        ...(final === null ? {} : { status: final.status, output: final.output }),
        ...(cancelled ? { status: 'CANCELLED' } : {}),
      },
      finishStepRun: { id: stepRunId, status: 'SUCCEEDED', output: outcome.event },
      events: [
        {
          type: 'STEP_SUCCEEDED',
          stateBefore: stepId,
          payload: { stepRunId, stepId, attempt, event: outcome.eventType },
        },
        {
          type: 'STATE_CHANGED',
          stateBefore: stepId,
          stateAfter: outcome.stateAfter,
          payload: { event: outcome.eventType },
        },
        ...(cancelled ? [{ ...cancelEvent, stateBefore: outcome.stateAfter }] : []),
      ],
    });
    log.info(
      {
        eventType: 'STEP_SUCCEEDED',
        durationMs: elapsed(),
        result: 'succeeded',
        nextState: outcome.stateAfter,
        ...(final === null ? {} : { executionStatus: final.status }),
        ...(cancelled ? { executionStatus: 'CANCELLED' } : {}),
      },
      'Step succeeded',
    );
    return final !== null || cancelled;
  }
}
