import {
  ExecutionEngine,
  InputValidationError,
  SqliteExecutionStore,
  WorkflowRegistry,
  openWorkflowDatabase,
} from '@aap/workflow-core';
import { afterEach, describe, expect, it } from 'vitest';
import { demoSequenceWorkflow } from '../src/index.js';

const database = openWorkflowDatabase(':memory:');
const store = new SqliteExecutionStore(database.db);
const engine = new ExecutionEngine({
  registry: new WorkflowRegistry([demoSequenceWorkflow]),
  store,
});

afterEach(() => engine.whenIdle());

describe('demo-sequence', () => {
  it('normalizes, processes and summarizes, then finishes when no review is asked', async () => {
    const { id } = engine.start('demo-sequence', {
      items: ['b', 'a', 'B'],
      stepDelayMs: 0,
      requireReview: false,
    });
    await engine.whenIdle();

    expect(store.getExecution(id)).toMatchObject({
      status: 'COMPLETED',
      output: { count: 2, results: ['B', 'A'], summary: 'Processed 2 item(s): B, A.' },
    });
    expect(store.listStepRuns(id).map((s) => s.stepId)).toEqual([
      'NORMALIZE',
      'PROCESS',
      'SUMMARIZE',
    ]);
  });

  it('waits for review by default, and records the reviewer feedback', async () => {
    const { id } = engine.start('demo-sequence', { items: ['x'], stepDelayMs: 0 });
    await engine.whenIdle();

    const approval = store.getPendingApproval(id);
    expect(store.getExecution(id)?.status).toBe('WAITING_FOR_APPROVAL');
    expect(approval?.request).toMatchObject({ summary: 'Processed 1 item(s): X.' });

    engine.decide(id, approval?.id ?? '', 'APPROVED', 'ship it');
    expect(store.getExecution(id)).toMatchObject({
      status: 'COMPLETED',
      output: { reviewFeedback: 'ship it' },
    });
  });

  it('declares every step safe to re-run after a crash', () => {
    for (const step of ['NORMALIZE', 'PROCESS', 'SUMMARIZE']) {
      expect(demoSequenceWorkflow.stepPolicy(step).recovery).toBe('rerun');
    }
  });

  it('applies the defaults when only items are given', () => {
    expect(demoSequenceWorkflow.prepare({ items: ['x'] }).context).toMatchObject({
      stepDelayMs: 500,
      requireReview: true,
      simulateFailures: 0,
    });
  });

  it('rejects an empty item list', () => {
    expect(() => demoSequenceWorkflow.prepare({ items: [] })).toThrow(InputValidationError);
  });
});
