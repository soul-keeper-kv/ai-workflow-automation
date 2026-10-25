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
  it('normalizes, processes and summarizes the items', async () => {
    const { id } = engine.start('demo-sequence', { items: ['b', 'a', 'B'], stepDelayMs: 0 });
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

  it('applies the default delay when none is given', () => {
    expect(demoSequenceWorkflow.prepare({ items: ['x'] }).context).toMatchObject({
      stepDelayMs: 500,
    });
  });

  it('rejects an empty item list', () => {
    expect(() => demoSequenceWorkflow.prepare({ items: [] })).toThrow(InputValidationError);
  });
});
