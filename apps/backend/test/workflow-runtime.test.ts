import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

const configs: ReturnType<typeof testConfig>[] = [];

function freshConfig() {
  const config = testConfig();
  configs.push(config);
  return config;
}

afterEach(() => {
  for (const config of configs.splice(0)) config.cleanup();
});

describe('workflow runtime inside the app', () => {
  it('creates the database in the data directory and registers the demo workflow', async () => {
    const config = freshConfig();
    const app = await buildApp(config);
    await app.ready();

    expect(existsSync(app.workflowRuntime.databasePath)).toBe(true);
    expect(app.workflowRuntime.databasePath.startsWith(config.dataDir)).toBe(true);
    expect(app.workflowRuntime.registry.list().map((w) => w.id)).toEqual(['demo-sequence']);
    await app.close();
  });

  it('keeps execution status across a normal restart, and resumes unfinished work', async () => {
    const config = freshConfig();

    const first = await buildApp(config);
    await first.ready();
    const finished = first.workflowRuntime.engine.start('demo-sequence', {
      items: ['a'],
      stepDelayMs: 0,
      requireReview: false,
    });
    await first.workflowRuntime.engine.whenIdle();
    const unfinished = first.workflowRuntime.engine.start('demo-sequence', {
      items: ['x', 'y', 'z'],
      stepDelayMs: 100,
      requireReview: false,
    });
    // Close while the demo is mid-way: the running step is allowed to finish, then the app stops.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await first.close();

    const afterStop = await buildApp(config);
    const store = afterStop.workflowRuntime.store;
    expect(store.getExecution(finished.id)?.status).toBe('COMPLETED');
    const paused = store.getExecution(unfinished.id);
    expect(paused?.status).toBe('RUNNING');
    expect(store.getRunningStepRun(unfinished.id)).toBeUndefined();

    await afterStop.ready(); // runs recovery
    await afterStop.workflowRuntime.engine.whenIdle();
    expect(store.getExecution(unfinished.id)).toMatchObject({
      status: 'COMPLETED',
      output: { count: 3, results: ['X', 'Y', 'Z'] },
    });
    // No step ran twice.
    expect(store.listStepRuns(unfinished.id).map((s) => s.stepId)).toEqual([
      'NORMALIZE',
      'PROCESS',
      'SUMMARIZE',
    ]);
    await afterStop.close();
  });
});
