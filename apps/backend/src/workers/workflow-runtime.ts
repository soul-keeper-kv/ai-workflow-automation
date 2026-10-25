import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ExecutionConflictError,
  ExecutionEngine,
  SqliteExecutionStore,
  WorkflowNotFoundError,
  WorkflowRegistry,
  openWorkflowDatabase,
  type ExecutionRecord,
  type Logger,
} from '@aap/workflow-core';
import type { WorkflowRequirement } from '@aap/shared';
import type { Integrations } from './integrations.js';
import type { Availability, RegisteredWorkflow } from './registered-workflows.js';

export const DATABASE_FILE_NAME = 'aap.db';

/** The workflow engine and its persistence, running inside the API process (blueprint §3.5). */
export interface WorkflowRuntime {
  readonly registry: WorkflowRegistry;
  readonly store: SqliteExecutionStore;
  readonly engine: ExecutionEngine;
  readonly databasePath: string;
  readonly integrations: Integrations;
  availability(workflowId: string): Availability;
  requirements(workflowId: string): readonly WorkflowRequirement[];
  /** Starts an execution if the workflow is available; otherwise ExecutionConflictError. */
  start(workflowId: string, input: unknown): ExecutionRecord;
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
  workflows: readonly RegisteredWorkflow[];
  integrations: Integrations;
  logger: Logger;
}): WorkflowRuntime {
  mkdirSync(options.dataDir, { recursive: true });
  const databasePath = join(options.dataDir, DATABASE_FILE_NAME);
  const database = openWorkflowDatabase(databasePath);

  try {
    const registry = new WorkflowRegistry(options.workflows.map((entry) => entry.workflow));
    const entries = new Map(options.workflows.map((entry) => [entry.workflow.id, entry] as const));
    const store = new SqliteExecutionStore(database.db);
    const engine = new ExecutionEngine({
      registry,
      store,
      logger: options.logger.child({ component: 'workflow-engine' }),
    });

    const availability = (workflowId: string): Availability => {
      const entry = entries.get(workflowId);
      if (entry === undefined) throw new WorkflowNotFoundError(workflowId);
      return entry.availability();
    };

    return {
      registry,
      store,
      engine,
      databasePath,
      integrations: options.integrations,
      availability,
      requirements: (workflowId) => entries.get(workflowId)?.requirements ?? [],
      start: (workflowId, input) => {
        const { available, reason } = availability(workflowId);
        if (!available) {
          throw new ExecutionConflictError(
            '',
            `This workflow cannot start: ${reason ?? 'unavailable'}`,
          );
        }
        return engine.start(workflowId, input);
      },
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
