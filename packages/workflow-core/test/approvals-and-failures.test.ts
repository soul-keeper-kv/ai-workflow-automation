import { setup } from 'xstate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ApprovalNotFoundError,
  ExecutionConflictError,
  StepError,
  WorkflowDefinitionError,
  defineWorkflow,
  type Workflow,
} from '../src/index.js';
import {
  createReviewWorkflow,
  type ReviewEvent,
  type ReviewStep,
} from './fixtures/review-workflow.js';
import { deferred, openHarness, tempDatabasePath, waitFor, type Harness } from './helpers.js';

let db: ReturnType<typeof tempDatabasePath>;
const open: Harness[] = [];

function harness(workflows: readonly Workflow[], options?: { abortGraceMs?: number }) {
  const h = openHarness(db.path, workflows, options);
  open.push(h);
  return h;
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

async function startAndWait(h: Harness) {
  const { id } = h.engine.start('test-review', { topic: 't' });
  await h.engine.whenIdle();
  return id;
}

function pendingApproval(h: Harness, id: string) {
  const approval = h.store.getPendingApproval(id);
  if (approval === undefined) throw new Error('expected a pending approval');
  return approval;
}

const abortable: ReviewStep = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason as Error));
  });

describe('approvals', () => {
  it('pauses in WAITING_FOR_APPROVAL with a pending request, and no step runs meanwhile', async () => {
    const h = harness([createReviewWorkflow()]);
    const id = await startAndWait(h);

    expect(h.store.getExecution(id)).toMatchObject({
      status: 'WAITING_FOR_APPROVAL',
      currentState: 'REVIEW',
    });
    expect(pendingApproval(h, id)).toMatchObject({
      approvalType: 'draft-review',
      state: 'REVIEW',
      status: 'PENDING',
      request: { draft: 'v1' },
    });
    expect(h.store.listEvents(id).map((e) => e.type)).toContain('APPROVAL_REQUESTED');
    expect(h.engine.isActive(id)).toBe(false);
  });

  it('continues to COMPLETED after approval, recording the decision', async () => {
    const h = harness([createReviewWorkflow()]);
    const id = await startAndWait(h);
    const approval = pendingApproval(h, id);

    const decided = h.engine.decide(id, approval.id, 'APPROVED', 'looks good');
    expect(decided.status).toBe('RUNNING');
    await h.engine.whenIdle();

    expect(h.store.getExecution(id)).toMatchObject({
      status: 'COMPLETED',
      output: { published: 'v1' },
      context: { feedback: 'looks good' },
    });
    expect(h.store.getApproval(approval.id)).toMatchObject({
      status: 'APPROVED',
      decision: { decision: 'APPROVED', feedback: 'looks good' },
    });
  });

  it('follows the machine to its rejection state', async () => {
    const h = harness([createReviewWorkflow()]);
    const id = await startAndWait(h);

    h.engine.decide(id, pendingApproval(h, id).id, 'REJECTED', null);

    expect(h.store.getExecution(id)).toMatchObject({
      status: 'CANCELLED',
      currentState: 'REJECTED',
    });
  });

  it('rejects a decision for an execution that is not waiting', async () => {
    const gate = deferred<ReviewEvent>();
    const h = harness([createReviewWorkflow({ WORK: () => gate.promise })]);
    const { id } = h.engine.start('test-review', { topic: 't' });
    await waitFor(() => h.store.getRunningStepRun(id) !== undefined);
    // A decision for a request of another execution is simply unknown here.
    expect(() =>
      h.engine.decide(id, '00000000-0000-4000-8000-000000000000', 'APPROVED', null),
    ).toThrow(ApprovalNotFoundError);
    gate.resolve({ type: 'DRAFTED', draft: 'v1' });
    await h.engine.whenIdle();
    const approval = pendingApproval(h, id);
    h.engine.decide(id, approval.id, 'APPROVED', null);
    await h.engine.whenIdle();

    expect(() => h.engine.decide(id, approval.id, 'APPROVED', null)).toThrow(
      ExecutionConflictError,
    );
  });

  it('refuses the same decision twice', async () => {
    const h = harness([createReviewWorkflow({ PUBLISH: abortable })]);
    const id = await startAndWait(h);
    const approval = pendingApproval(h, id);

    h.engine.decide(id, approval.id, 'APPROVED', null);

    expect(() => h.engine.decide(id, approval.id, 'REJECTED', null)).toThrow(
      ExecutionConflictError,
    );
  });

  it('closes the pending request when the execution is cancelled', async () => {
    const h = harness([createReviewWorkflow()]);
    const id = await startAndWait(h);
    const approval = pendingApproval(h, id);

    expect(h.engine.cancel(id).outcome).toBe('cancelled');

    expect(h.store.getExecution(id)?.status).toBe('CANCELLED');
    expect(h.store.getApproval(approval.id)?.status).toBe('CANCELLED');
    expect(() => h.engine.decide(id, approval.id, 'APPROVED', null)).toThrow(
      ExecutionConflictError,
    );
  });

  it('keeps waiting across a restart, and accepts the decision afterwards', async () => {
    const first = harness([createReviewWorkflow()]);
    const id = await startAndWait(first);
    await first.engine.stop();
    first.database.close();
    open.splice(open.indexOf(first), 1);

    const second = harness([createReviewWorkflow()]);
    expect(second.engine.recover()).toEqual({ resumed: [], rerun: [], interrupted: [] });
    expect(second.store.getExecution(id)?.status).toBe('WAITING_FOR_APPROVAL');

    second.engine.decide(id, pendingApproval(second, id).id, 'APPROVED', null);
    await second.engine.whenIdle();
    expect(second.store.getExecution(id)?.status).toBe('COMPLETED');
  });

  it('rejects an approval state that does not handle both decisions', () => {
    const machine = setup({
      types: {
        context: {},
        events: {} as { type: 'GO' } | { type: 'APPROVED'; feedback: string | null },
      },
    }).createMachine({
      initial: 'A',
      context: {},
      states: { A: { on: { GO: 'R' } }, R: { on: { APPROVED: 'D' } }, D: { type: 'final' } },
    });

    expect(() =>
      defineWorkflow({
        id: 'half-review',
        version: '1.0.0',
        name: 'Half',
        description: 'Missing REJECTED.',
        category: 'Test',
        machine,
        inputSchema: z.undefined(),
        contextSchema: z.object({}),
        outputSchema: z.undefined(),
        states: {
          A: { kind: 'step', title: 'A', run: () => Promise.resolve({ type: 'GO' as const }) },
          R: { kind: 'approval', title: 'R', approvalType: 'x', request: () => ({}) },
          D: { kind: 'final', title: 'D', status: 'COMPLETED' },
        },
      }),
    ).toThrow(WorkflowDefinitionError);
  });
});

describe('retries', () => {
  const failing = (times: number, retryable = true): ReviewStep => {
    let calls = 0;
    return () => {
      calls += 1;
      return calls <= times
        ? Promise.reject(new StepError(`flaky ${calls}`, { code: 'FLAKY', retryable }))
        : Promise.resolve({ type: 'DRAFTED', draft: `after ${calls}` });
    };
  };

  it('retries a retryable failure within its budget, then continues', async () => {
    const h = harness([
      createReviewWorkflow({
        WORK: failing(2),
        workPolicy: { retry: { maxAttempts: 3, initialDelayMs: 5 } },
      }),
    ]);
    const id = await startAndWait(h);

    expect(h.store.getExecution(id)).toMatchObject({
      status: 'WAITING_FOR_APPROVAL',
      context: { draft: 'after 3' },
    });
    expect(h.store.listStepRuns(id).map((s) => [s.attempt, s.status])).toEqual([
      [1, 'FAILED'],
      [2, 'FAILED'],
      [3, 'SUCCEEDED'],
    ]);
    expect(h.store.listEvents(id).filter((e) => e.type === 'STEP_RETRY_SCHEDULED')).toHaveLength(2);
  });

  it('does not retry an error that is not marked retryable', async () => {
    const h = harness([
      createReviewWorkflow({
        WORK: failing(1, false),
        workPolicy: { retry: { maxAttempts: 3, initialDelayMs: 5 } },
      }),
    ]);
    const id = await startAndWait(h);

    expect(h.store.getExecution(id)).toMatchObject({ status: 'FAILED', error: { code: 'FLAKY' } });
    expect(h.store.listStepRuns(id)).toHaveLength(1);
  });

  it('fails once the budget is spent', async () => {
    const h = harness([
      createReviewWorkflow({
        WORK: failing(5),
        workPolicy: { retry: { maxAttempts: 3, initialDelayMs: 5 } },
      }),
    ]);
    const id = await startAndWait(h);

    expect(h.store.getExecution(id)).toMatchObject({
      status: 'FAILED',
      error: { message: 'flaky 3' },
    });
    expect(h.store.listStepRuns(id).map((s) => s.status)).toEqual(['FAILED', 'FAILED', 'FAILED']);
  });

  it('waits with exponential backoff between attempts', async () => {
    const h = harness([
      createReviewWorkflow({
        WORK: failing(2),
        workPolicy: { retry: { maxAttempts: 3, initialDelayMs: 60, multiplier: 2 } },
      }),
    ]);
    const started = Date.now();
    await startAndWait(h);

    expect(Date.now() - started).toBeGreaterThanOrEqual(170); // 60 + 120, less timer slack
  });

  it('cancels during the backoff without waiting it out', async () => {
    const h = harness([
      createReviewWorkflow({
        WORK: failing(5),
        workPolicy: { retry: { maxAttempts: 5, initialDelayMs: 10_000 } },
      }),
    ]);
    const { id } = h.engine.start('test-review', { topic: 't' });
    await waitFor(() => h.store.listEvents(id).some((e) => e.type === 'STEP_RETRY_SCHEDULED'));

    const started = Date.now();
    expect(h.engine.cancel(id).outcome).toBe('requested');
    await h.engine.whenIdle();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(h.store.getExecution(id)?.status).toBe('CANCELLED');
  });
});

describe('timeouts', () => {
  it('fails a step that runs past its timeout', async () => {
    const h = harness([createReviewWorkflow({ WORK: abortable, workPolicy: { timeoutMs: 30 } })]);
    const id = await startAndWait(h);

    expect(h.store.getExecution(id)).toMatchObject({
      status: 'FAILED',
      error: { code: 'STEP_TIMEOUT' },
    });
  });

  it('retries a timeout when the policy allows it', async () => {
    let calls = 0;
    const slowThenFast: ReviewStep = (step) => {
      calls += 1;
      return calls === 1 ? abortable(step) : Promise.resolve({ type: 'DRAFTED', draft: 'fast' });
    };
    const h = harness([
      createReviewWorkflow({
        WORK: slowThenFast,
        workPolicy: {
          timeoutMs: 30,
          retry: { maxAttempts: 2, initialDelayMs: 5, retryOnTimeout: true },
        },
      }),
    ]);
    const id = await startAndWait(h);

    expect(h.store.getExecution(id)?.status).toBe('WAITING_FOR_APPROVAL');
    expect(h.store.listStepRuns(id).map((s) => [s.status, s.error?.code ?? null])).toEqual([
      ['FAILED', 'STEP_TIMEOUT'],
      ['SUCCEEDED', null],
    ]);
  });

  it('abandons a step that ignores the abort, and never retries it', async () => {
    let calls = 0;
    const h = harness(
      [
        createReviewWorkflow({
          WORK: () => {
            calls += 1;
            return new Promise<ReviewEvent>(() => undefined);
          },
          workPolicy: {
            timeoutMs: 20,
            retry: { maxAttempts: 3, initialDelayMs: 5, retryOnTimeout: true },
          },
        }),
      ],
      { abortGraceMs: 20 },
    );
    const id = await startAndWait(h);

    expect(h.store.getExecution(id)).toMatchObject({
      status: 'FAILED',
      error: { code: 'STEP_TIMEOUT' },
    });
    expect(h.store.getExecution(id)?.error?.message).toMatch(/may still be running/);
    expect(calls).toBe(1);
  });
});

describe('recovery policy and resume', () => {
  it('re-runs a step marked safe to repeat after a crash', async () => {
    let calls = 0;
    const work: ReviewStep = () => {
      calls += 1;
      return calls === 1
        ? new Promise<ReviewEvent>(() => undefined)
        : Promise.resolve({ type: 'DRAFTED', draft: 'rerun' });
    };
    const first = harness([
      createReviewWorkflow({ WORK: work, workPolicy: { recovery: 'rerun' } }),
    ]);
    const { id } = first.engine.start('test-review', { topic: 't' });
    await waitFor(() => first.store.getRunningStepRun(id) !== undefined);
    first.database.close(); // crash
    open.splice(open.indexOf(first), 1);

    const second = harness([
      createReviewWorkflow({ WORK: work, workPolicy: { recovery: 'rerun' } }),
    ]);
    expect(second.engine.recover()).toEqual({ resumed: [], rerun: [id], interrupted: [] });
    await second.engine.whenIdle();

    expect(second.store.getExecution(id)).toMatchObject({
      status: 'WAITING_FOR_APPROVAL',
      context: { draft: 'rerun' },
    });
    expect(second.store.listStepRuns(id).map((s) => s.status)).toEqual([
      'INTERRUPTED',
      'SUCCEEDED',
    ]);
  });

  it('resumes an INTERRUPTED execution when a person asks', async () => {
    let calls = 0;
    const work: ReviewStep = (step) => {
      calls += 1;
      return calls === 1
        ? abortable(step)
        : Promise.resolve({ type: 'DRAFTED', draft: 'second try' });
    };
    const h = harness([createReviewWorkflow({ WORK: work })]);
    const { id } = h.engine.start('test-review', { topic: 't' });
    await waitFor(() => h.store.getRunningStepRun(id) !== undefined);
    await h.engine.stop({ drainTimeoutMs: 10 });
    h.database.close();
    open.splice(open.indexOf(h), 1);

    const after = harness([createReviewWorkflow({ WORK: work })]);
    expect(after.store.getExecution(id)?.status).toBe('INTERRUPTED');
    expect(after.engine.resume(id)).toMatchObject({ status: 'RUNNING', error: null });
    await after.engine.whenIdle();

    expect(after.store.getExecution(id)?.status).toBe('WAITING_FOR_APPROVAL');
    expect(after.store.listEvents(id).map((e) => e.type)).toContain('EXECUTION_RESUMED');
  });

  it('refuses to resume an execution that is not INTERRUPTED', async () => {
    const h = harness([createReviewWorkflow()]);
    const id = await startAndWait(h);

    expect(() => h.engine.resume(id)).toThrow(ExecutionConflictError);
  });
});

describe('FAILED final states', () => {
  it('report the error named by the final state', async () => {
    const machine = setup({
      types: { context: {}, events: {} as { type: 'GIVE_UP' } },
    }).createMachine({
      initial: 'TRY',
      context: {},
      states: { TRY: { on: { GIVE_UP: 'GAVE_UP' } }, GAVE_UP: { type: 'final' } },
    });
    const workflow = defineWorkflow({
      id: 'gives-up',
      version: '1.0.0',
      name: 'Gives up',
      description: 'Ends in a FAILED final state.',
      category: 'Test',
      machine,
      inputSchema: z.object({}),
      contextSchema: z.object({}),
      outputSchema: z.undefined(),
      states: {
        TRY: {
          kind: 'step',
          title: 'Try',
          run: () => Promise.resolve({ type: 'GIVE_UP' as const }),
        },
        GAVE_UP: {
          kind: 'final',
          title: 'Gave up',
          status: 'FAILED',
          errorCode: 'NOT_POSSIBLE',
          errorMessage: 'It could not be done.',
        },
      },
    });
    const h = harness([workflow]);
    const { id } = h.engine.start('gives-up', {});
    await h.engine.whenIdle();

    expect(h.store.getExecution(id)).toMatchObject({
      status: 'FAILED',
      error: { code: 'NOT_POSSIBLE', message: 'It could not be done.' },
    });
  });
});
