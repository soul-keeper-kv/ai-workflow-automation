import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExecutionEngine,
  SqliteExecutionStore,
  WorkflowRegistry,
  openWorkflowDatabase,
  type Workflow,
  type WorkflowDatabase,
} from '../src/index.js';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A database file in its own temporary directory, removed by `cleanup`. */
export function tempDatabasePath(): { path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'aap-core-'));
  return {
    path: join(dir, 'test.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface Harness {
  database: WorkflowDatabase;
  store: SqliteExecutionStore;
  registry: WorkflowRegistry;
  engine: ExecutionEngine;
}

/** One "app process": database, store, registry and engine over the same file. */
export function openHarness(
  path: string,
  workflows: readonly Workflow[],
  options: { maxConcurrentExecutions?: number } = {},
): Harness {
  const database = openWorkflowDatabase(path);
  const store = new SqliteExecutionStore(database.db);
  const registry = new WorkflowRegistry(workflows);
  const engine = new ExecutionEngine({
    registry,
    store,
    ...(options.maxConcurrentExecutions === undefined
      ? {}
      : { maxConcurrentExecutions: options.maxConcurrentExecutions }),
  });
  return { database, store, registry, engine };
}

/** Waits until `predicate` holds, polling the event loop. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
