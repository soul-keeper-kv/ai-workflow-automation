import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ExecutionConflictError,
  ExecutionNotFoundError,
  InputValidationError,
  StepError,
  WorkflowNotFoundError,
  type Workflow,
} from '../src/index.js';
import { createSequenceWorkflow, type SequenceEvent } from './fixtures/sequence-workflow.js';
import { deferred, openHarness, tempDatabasePath, waitFor, type Harness } from './helpers.js';

let db: ReturnType<typeof tempDatabasePath>;
const open: Harness[] = [];

function harness(workflows: readonly Workflow[], options?: { maxConcurrentExecutions?: number }) {
  const h = openHarness(db.path, workflows, options);
  open.push(h);
  return h;
}

/** Simulates the process going away: no graceful stop, just the connection closing. */
function crash(h: Harness) {
  h.database.close();
}

beforeEach(() => {
  db = tempDatabasePath();
});

afterEach(async () => {
  for (const h of open.splice(0)) {
    await h.engine.stop({ drainTimeoutMs: 50, abortTimeoutMs: 50 });
    h.database.close();
  }
  db.cleanup();
});

describe('ExecutionEngine.start', () => {
  it('returns a PENDING execution before any step finishes', async () => {
    const gate = deferred<SequenceEvent>();
    const { engine, store } = harness([createSequenceWorkflow({ FIRST: () => gate.promise })]);

    const execution = engine.start('test-sequence', { label: 'a' });

    expect(execution.status).toBe('PENDING');
    await waitFor(() => store.getRunningStepRun(execution.id) !== undefined);
    expect(store.getExecution(execution.id)?.status).toBe('RUNNING');
    gate.resolve({ type: 'NEXT', mark: 'first' });
    await engine.whenIdle();
  });

  it('rejects invalid input and creates nothing', () => {
    const { engine, database } = harness([createSequenceWorkflow()]);

    expect(() => engine.start('test-sequence', { label: '' })).toThrow(InputValidationError);
    const rows = database.sqlite.prepare('select count(*) as n from workflow_executions').get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });

  it('rejects an unknown workflow', () => {
    const { engine } = harness([createSequenceWorkflow()]);

    expect(() => engine.start('nope', {})).toThrow(WorkflowNotFoundError);
  });
});

describe('ExecutionEngine run loop', () => {
  it('runs every step in order to COMPLETED and records the history', async () => {
    const { engine, store } = harness([createSequenceWorkflow()]);

    const { id } = engine.start('test-sequence', { label: 'a' });
    await engine.whenIdle();

    expect(store.getExecution(id)).toMatchObject({
      status: 'COMPLETED',
      currentState: 'DONE',
      output: { label: 'a', trail: ['first', 'second'] },
      error: null,
    });
    expect(store.listStepRuns(id).map((s) => [s.stepId, s.status, s.attempt, s.output])).toEqual([
      ['FIRST', 'SUCCEEDED', 1, { type: 'NEXT', mark: 'first' }],
      ['SECOND', 'SUCCEEDED', 1, { type: 'NEXT', mark: 'second' }],
    ]);
    expect(store.listEvents(id).map((e) => e.type)).toEqual([
      'EXECUTION_CREATED',
      'STEP_STARTED',
      'STATUS_CHANGED', // PENDING -> RUNNING
      'STEP_SUCCEEDED',
      'STATE_CHANGED', // FIRST -> SECOND
      'STEP_STARTED',
      'STEP_SUCCEEDED',
      'STATE_CHANGED', // SECOND -> DONE
      'STATUS_CHANGED', // RUNNING -> COMPLETED
    ]);
  });

  it('maps a CANCELLED final state to the CANCELLED status', async () => {
    const { engine, store } = harness([
      createSequenceWorkflow({ FIRST: () => Promise.resolve({ type: 'REJECT' }) }),
    ]);

    const { id } = engine.start('test-sequence', { label: 'a' });
    await engine.whenIdle();

    expect(store.getExecution(id)).toMatchObject({ status: 'CANCELLED', currentState: 'REJECTED' });
  });

  it('fails the execution when a step returns an event its state rejects', async () => {
    const { engine, store } = harness([
      createSequenceWorkflow({ FIRST: () => Promise.resolve({ type: 'UNHANDLED' }) }),
    ]);

    const { id } = engine.start('test-sequence', { label: 'a' });
    await engine.whenIdle();

    expect(store.getExecution(id)).toMatchObject({
      status: 'FAILED',
      currentState: 'FIRST',
      error: { code: 'INVALID_TRANSITION' },
    });
    expect(store.listStepRuns(id)[0]?.status).toBe('FAILED');
  });

  it('records the code of a StepError', async () => {
    const { engine, store } = harness([
      createSequenceWorkflow({
        SECOND: () => Promise.reject(new StepError('disk full', { code: 'NO_SPACE' })),
      }),
    ]);

    const { id } = engine.start('test-sequence', { label: 'a' });
    await engine.whenIdle();

    expect(store.getExecution(id)).toMatchObject({
      status: 'FAILED',
      currentState: 'SECOND',
      error: { code: 'NO_SPACE', message: 'disk full' },
    });
  });

  it('runs at most maxConcurrentExecutions at a time', async () => {
    const gate = deferred<SequenceEvent>();
    let running = 0;
    let peak = 0;
    const { engine } = harness(
      [
        createSequenceWorkflow({
          FIRST: async () => {
            running += 1;
            peak = Math.max(peak, running);
            await gate.promise;
            running -= 1;
            return { type: 'REJECT' };
          },
        }),
      ],
      { maxConcurrentExecutions: 1 },
    );

    engine.start('test-sequence', { label: 'a' });
    engine.start('test-sequence', { label: 'b' });
    await sleep(30);
    expect(peak).toBe(1);
    gate.resolve({ type: 'REJECT' });
    await engine.whenIdle();
    expect(peak).toBe(1);
  });
});

describe('restart and recovery', () => {
  it('keeps a finished execution exactly as it was after a restart', async () => {
    const first = harness([createSequenceWorkflow()]);
    const { id } = first.engine.start('test-sequence', { label: 'a' });
    await first.engine.whenIdle();
    await first.engine.stop();
    first.database.close();

    const second = harness([createSequenceWorkflow()]);
    expect(second.engine.recover()).toEqual({ resumed: [], interrupted: [] });
    expect(second.store.getExecution(id)).toMatchObject({
      status: 'COMPLETED',
      output: { label: 'a', trail: ['first', 'second'] },
    });
  });

  it('lets a running step finish during a graceful stop, then resumes after restart', async () => {
    const gate = deferred<SequenceEvent>();
    let firstRuns = 0;
    const blockingFirst = () => {
      firstRuns += 1;
      return gate.promise;
    };
    const first = harness([createSequenceWorkflow({ FIRST: blockingFirst })]);
    const { id } = first.engine.start('test-sequence', { label: 'a' });
    await waitFor(() => first.store.getRunningStepRun(id) !== undefined);

    const stopping = first.engine.stop({ drainTimeoutMs: 1_000 });
    gate.resolve({ type: 'NEXT', mark: 'first' });
    await stopping;
    first.database.close();

    // Stopped between steps: FIRST committed, SECOND never started.
    const second = harness([createSequenceWorkflow({ FIRST: blockingFirst })]);
    expect(second.store.getExecution(id)).toMatchObject({
      status: 'RUNNING',
      currentState: 'SECOND',
    });
    expect(second.engine.recover()).toEqual({ resumed: [id], interrupted: [] });
    await second.engine.whenIdle();

    expect(second.store.getExecution(id)?.status).toBe('COMPLETED');
    expect(firstRuns).toBe(1);
  });

  it('interrupts a step that does not finish in time and does not resume it', async () => {
    const first = harness([
      createSequenceWorkflow({
        FIRST: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason as Error));
          }),
      }),
    ]);
    const { id } = first.engine.start('test-sequence', { label: 'a' });
    await waitFor(() => first.store.getRunningStepRun(id) !== undefined);

    await first.engine.stop({ drainTimeoutMs: 20, abortTimeoutMs: 500 });

    expect(first.store.getExecution(id)).toMatchObject({
      status: 'INTERRUPTED',
      error: { code: 'INTERRUPTED' },
    });
    expect(first.store.listStepRuns(id)[0]?.status).toBe('INTERRUPTED');
    first.database.close();

    const second = harness([createSequenceWorkflow()]);
    expect(second.engine.recover()).toEqual({ resumed: [], interrupted: [] });
    expect(second.store.getExecution(id)?.status).toBe('INTERRUPTED');
  });

  it('after a crash mid-step, marks the execution INTERRUPTED instead of re-running the step', async () => {
    let firstRuns = 0;
    const neverFinishes = () => {
      firstRuns += 1;
      return new Promise<SequenceEvent>(() => undefined);
    };
    const first = harness([createSequenceWorkflow({ FIRST: neverFinishes })]);
    const { id } = first.engine.start('test-sequence', { label: 'a' });
    await waitFor(() => first.store.getRunningStepRun(id) !== undefined);
    crash(first);
    open.splice(open.indexOf(first), 1);

    const second = harness([createSequenceWorkflow({ FIRST: neverFinishes })]);
    expect(second.engine.recover()).toEqual({ resumed: [], interrupted: [id] });

    expect(second.store.getExecution(id)).toMatchObject({
      status: 'INTERRUPTED',
      currentState: 'FIRST',
      error: { code: 'INTERRUPTED' },
    });
    expect(second.store.listStepRuns(id).map((s) => s.status)).toEqual(['INTERRUPTED']);
    expect(second.store.getRunningStepRun(id)).toBeUndefined();
    expect(firstRuns).toBe(1);
  });

  it('resumes a PENDING execution that never started', async () => {
    const first = harness([createSequenceWorkflow()]);
    const id = first.store.createExecution({
      id: 'pending-1',
      workflowId: 'test-sequence',
      workflowVersion: '1.0.0',
      currentState: 'FIRST',
      input: { label: 'a' },
      context: { label: 'a', trail: [] },
    }).id;

    expect(first.engine.recover().resumed).toEqual([id]);
    await first.engine.whenIdle();
    expect(first.store.getExecution(id)?.status).toBe('COMPLETED');
  });

  it('does not resume an execution whose workflow version is no longer registered', async () => {
    const gate = deferred<SequenceEvent>();
    const first = harness([createSequenceWorkflow({ FIRST: () => gate.promise })]);
    const { id } = first.engine.start('test-sequence', { label: 'a' });
    await waitFor(() => first.store.getRunningStepRun(id) !== undefined);
    const stopping = first.engine.stop({ drainTimeoutMs: 1_000 });
    gate.resolve({ type: 'NEXT', mark: 'first' });
    await stopping;
    first.database.close();

    const second = harness([createSequenceWorkflow({}, '2.0.0')]);
    second.engine.recover();
    await second.engine.whenIdle();

    expect(second.store.getExecution(id)).toMatchObject({
      status: 'INTERRUPTED',
      currentState: 'SECOND',
      error: { code: 'WORKFLOW_UNAVAILABLE' },
    });
  });
});

describe('ExecutionEngine.cancel', () => {
  const abortable =
    (onStart?: () => void) =>
    ({ signal }: { signal: AbortSignal }) =>
      new Promise<SequenceEvent>((_resolve, reject) => {
        onStart?.();
        signal.addEventListener('abort', () => reject(signal.reason as Error));
      });

  it('aborts the running step and ends CANCELLED, keeping the history', async () => {
    let secondRan = false;
    const { engine, store } = harness([
      createSequenceWorkflow({
        FIRST: abortable(),
        SECOND: () => {
          secondRan = true;
          return Promise.resolve({ type: 'NEXT', mark: 'second' });
        },
      }),
    ]);
    const { id } = engine.start('test-sequence', { label: 'a' });
    await waitFor(() => store.getRunningStepRun(id) !== undefined);

    const result = engine.cancel(id);
    expect(result.outcome).toBe('requested');
    expect(engine.isCancelRequested(id)).toBe(true);
    await engine.whenIdle();

    expect(store.getExecution(id)).toMatchObject({ status: 'CANCELLED', currentState: 'FIRST' });
    expect(store.listStepRuns(id).map((s) => [s.status, s.error?.code])).toEqual([
      ['INTERRUPTED', 'CANCELLED'],
    ]);
    const types = store.listEvents(id).map((e) => e.type);
    expect(types.slice(-3)).toEqual(['CANCEL_REQUESTED', 'STEP_INTERRUPTED', 'STATUS_CHANGED']);
    expect(secondRan).toBe(false);
    expect(engine.isCancelRequested(id)).toBe(false);
  });

  it('keeps the result of a step that finishes despite the cancel, then stops', async () => {
    const gate = deferred<SequenceEvent>();
    let secondRan = false;
    const { engine, store } = harness([
      createSequenceWorkflow({
        FIRST: () => gate.promise, // ignores the signal
        SECOND: () => {
          secondRan = true;
          return Promise.resolve({ type: 'NEXT', mark: 'second' });
        },
      }),
    ]);
    const { id } = engine.start('test-sequence', { label: 'a' });
    await waitFor(() => store.getRunningStepRun(id) !== undefined);

    engine.cancel(id);
    gate.resolve({ type: 'NEXT', mark: 'first' });
    await engine.whenIdle();

    expect(store.getExecution(id)).toMatchObject({
      status: 'CANCELLED',
      currentState: 'SECOND',
      context: { label: 'a', trail: ['first'] },
    });
    expect(store.listStepRuns(id).map((s) => s.status)).toEqual(['SUCCEEDED']);
    expect(secondRan).toBe(false);
  });

  it('cancels a queued execution at once, before it ever runs', async () => {
    const gate = deferred<SequenceEvent>();
    const { engine, store } = harness([createSequenceWorkflow({ FIRST: () => gate.promise })], {
      maxConcurrentExecutions: 1,
    });
    engine.start('test-sequence', { label: 'running' });
    const queued = engine.start('test-sequence', { label: 'queued' });

    const result = engine.cancel(queued.id);

    expect(result.outcome).toBe('cancelled');
    expect(result.execution.status).toBe('CANCELLED');
    gate.resolve({ type: 'REJECT' });
    await engine.whenIdle();
    expect(store.listStepRuns(queued.id)).toEqual([]);
  });

  it('cancels an INTERRUPTED execution', async () => {
    const first = harness([createSequenceWorkflow({ FIRST: abortable() })]);
    const { id } = first.engine.start('test-sequence', { label: 'a' });
    await waitFor(() => first.store.getRunningStepRun(id) !== undefined);
    await first.engine.stop({ drainTimeoutMs: 10 });
    expect(first.store.getExecution(id)?.status).toBe('INTERRUPTED');
    first.database.close();

    const second = harness([createSequenceWorkflow()]);
    expect(second.engine.cancel(id)).toMatchObject({
      outcome: 'cancelled',
      execution: { status: 'CANCELLED' },
    });
  });

  it('refuses to cancel a finished execution', async () => {
    const { engine } = harness([createSequenceWorkflow()]);
    const { id } = engine.start('test-sequence', { label: 'a' });
    await engine.whenIdle();

    expect(() => engine.cancel(id)).toThrow(ExecutionConflictError);
  });

  it('reports an unknown execution', () => {
    const { engine } = harness([createSequenceWorkflow()]);

    expect(() => engine.cancel('missing')).toThrow(ExecutionNotFoundError);
  });
});
