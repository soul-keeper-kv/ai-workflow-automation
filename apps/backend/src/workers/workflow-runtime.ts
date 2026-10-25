import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ExecutionEngine,
  SqliteExecutionStore,
  WorkflowRegistry,
  openWorkflowDatabase,
  type Logger,
  type Workflow,
} from '@aap/workflow-core';

export const DATABASE_FILE_NAME = 'aap.db';

/** The workflow engine and its persistence, running inside the API process (blueprint §3.5). */
export interface WorkflowRuntime {
  readonly registry: WorkflowRegistry;
  readonly store: SqliteExecutionStore;
  readonly engine: ExecutionEngine;
  readonly databasePath: string;
  /** Stops the engine gracefully, then closes the database. */
  close(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    workflowRuntime: WorkflowRuntime;
  }
}

export function createWorkflowRuntime(options: {
  dataDir: string;
  workflows: readonly Workflow[];
  logger: Logger;
}): WorkflowRuntime {
  mkdirSync(options.dataDir, { recursive: true });
  const databasePath = join(options.dataDir, DATABASE_FILE_NAME);
  const database = openWorkflowDatabase(databasePath);

  try {
    const registry = new WorkflowRegistry(options.workflows);
    const store = new SqliteExecutionStore(database.db);
    const engine = new ExecutionEngine({
      registry,
      store,
      logger: options.logger.child({ component: 'workflow-engine' }),
    });

    return {
      registry,
      store,
      engine,
      databasePath,
      close: async () => {
        try {
          await engine.stop();
        } finally {
          database.close();
        }
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
