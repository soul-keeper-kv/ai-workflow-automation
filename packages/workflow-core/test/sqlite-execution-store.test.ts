import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConcurrentModificationError,
  CorruptRecordError,
  InvalidStatusTransitionError,
  PayloadTooLargeError,
  SqliteExecutionStore,
  openWorkflowDatabase,
  type WorkflowDatabase,
} from '../src/index.js';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

let database: WorkflowDatabase;
let now: number;
let store: SqliteExecutionStore;

beforeEach(() => {
  database = openWorkflowDatabase(':memory:');
  now = T0;
  store = new SqliteExecutionStore(database.db, {
    clock: () => new Date(now),
    limits: { jsonBytes: 1024, eventPayloadBytes: 256 },
  });
});

afterEach(() => database.close());

function create(id = 'e1') {
  return store.createExecution({
    id,
    workflowId: 'w',
    workflowVersion: '1.0.0',
    currentState: 'FIRST',
    input: { a: 1 },
    context: { trail: [] },
  });
}

const eventCount = () => store.listEvents('e1').length;

describe('SqliteExecutionStore', () => {
  it('creates a PENDING execution with an EXECUTION_CREATED event', () => {
    create();

    const execution = store.getExecution('e1');
    expect(execution).toMatchObject({
      status: 'PENDING',
      currentState: 'FIRST',
      input: { a: 1 },
      context: { trail: [] },
      revision: 0,
      startedAt: null,
    });
    expect(store.listEvents('e1').map((e) => e.type)).toEqual(['EXECUTION_CREATED']);
  });

  it('stores timestamps as UTC epoch milliseconds', () => {
    create();

    const raw = database.sqlite
      .prepare('select created_at as createdAt from workflow_executions where id = ?')
      .get('e1') as { createdAt: number };
    expect(raw.createdAt).toBe(T0);
  });

  it('applies a change atomically and records the status change', () => {
    create();
    now = T0 + 1000;

    const updated = store.applyChange({
      executionId: 'e1',
      expectedRevision: 0,
      execution: { status: 'RUNNING' },
      startStepRun: { id: 's1', stepId: 'FIRST', attempt: 1 },
      events: [{ type: 'STEP_STARTED', stateBefore: 'FIRST' }],
    });

    expect(updated).toMatchObject({
      status: 'RUNNING',
      revision: 1,
      startedAt: new Date(T0 + 1000),
    });
    expect(store.getRunningStepRun('e1')?.id).toBe('s1');
    expect(store.listEvents('e1').map((e) => e.type)).toEqual([
      'EXECUTION_CREATED',
      'STEP_STARTED',
      'STATUS_CHANGED',
    ]);
    expect(store.listEvents('e1')[2]?.payload).toEqual({ from: 'PENDING', to: 'RUNNING' });
  });

  it('sets completedAt when the status becomes terminal', () => {
    create();
    store.applyChange({ executionId: 'e1', expectedRevision: 0, execution: { status: 'RUNNING' } });
    now = T0 + 5000;

    const done = store.applyChange({
      executionId: 'e1',
      expectedRevision: 1,
      execution: { status: 'COMPLETED', output: { ok: true } },
    });

    expect(done).toMatchObject({ completedAt: new Date(T0 + 5000), output: { ok: true } });
  });

  it('rejects a stale revision and writes nothing', () => {
    create();
    store.applyChange({ executionId: 'e1', expectedRevision: 0, execution: { status: 'RUNNING' } });
    const before = eventCount();

    expect(() =>
      store.applyChange({
        executionId: 'e1',
        expectedRevision: 0,
        execution: { status: 'FAILED' },
        events: [{ type: 'STEP_FAILED' }],
      }),
    ).toThrow(ConcurrentModificationError);
    expect(store.getExecution('e1')?.status).toBe('RUNNING');
    expect(eventCount()).toBe(before);
  });

  it('rejects an invalid lifecycle transition and rolls back the whole change', () => {
    create();

    expect(() =>
      store.applyChange({
        executionId: 'e1',
        expectedRevision: 0,
        execution: { status: 'COMPLETED' },
        startStepRun: { id: 's1', stepId: 'FIRST', attempt: 1 },
        events: [{ type: 'STEP_STARTED' }],
      }),
    ).toThrow(InvalidStatusTransitionError);
    expect(store.getExecution('e1')).toMatchObject({ status: 'PENDING', revision: 0 });
    expect(store.listStepRuns('e1')).toEqual([]);
    expect(eventCount()).toBe(1);
  });

  it('rejects finishing a step run that is not running', () => {
    create();

    expect(() =>
      store.applyChange({
        executionId: 'e1',
        expectedRevision: 0,
        finishStepRun: { id: 'missing', status: 'SUCCEEDED' },
      }),
    ).toThrow(CorruptRecordError);
    expect(store.getExecution('e1')?.revision).toBe(0);
  });

  it('rejects payloads over the size limit', () => {
    expect(() =>
      store.createExecution({
        id: 'big',
        workflowId: 'w',
        workflowVersion: '1.0.0',
        currentState: 'FIRST',
        input: { blob: 'x'.repeat(2000) },
        context: {},
      }),
    ).toThrow(PayloadTooLargeError);
    expect(store.getExecution('big')).toBeUndefined();
  });

  it('detects JSON that was corrupted in the database', () => {
    create();
    database.sqlite
      .prepare("update workflow_executions set context_json = '{oops' where id = 'e1'")
      .run();

    expect(() => store.getExecution('e1')).toThrow(CorruptRecordError);
  });

  it('truncates long error messages', () => {
    const small = new SqliteExecutionStore(database.db, { limits: { errorMessageChars: 10 } });
    create();

    const failed = small.applyChange({
      executionId: 'e1',
      expectedRevision: 0,
      execution: { status: 'FAILED', error: { code: 'X', message: 'a'.repeat(50) } },
    });

    expect(failed.error?.message).toHaveLength(10);
  });
});
