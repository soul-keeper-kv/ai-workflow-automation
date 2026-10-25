import cors from '@fastify/cors';
import type { Workflow } from '@aap/workflow-core';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { healthRoutes } from './api/health.js';
import type { AppConfig } from './config/env.js';
import { executionRoutes } from './modules/executions/execution-routes.js';
import { workflowRoutes } from './modules/workflows/workflow-routes.js';
import { registerErrorHandling } from './plugins/error-handler.js';
import { registerSecurity } from './plugins/security.js';
import { APP_VERSION } from './version.js';
import { REGISTERED_WORKFLOWS } from './workers/registered-workflows.js';
import { createWorkflowRuntime } from './workers/workflow-runtime.js';

function loggerOptions(config: AppConfig): FastifyServerOptions['logger'] {
  return {
    level: config.logLevel,
    // Nothing logs headers today; this keeps a future auth header out of the logs by default.
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    ...(config.logFormat === 'pretty'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}

export interface BuildAppOptions {
  /** Defaults to REGISTERED_WORKFLOWS. Tests pass fixtures. */
  workflows?: readonly Workflow[];
}

/** Builds the app without listening, so tests can drive it with `app.inject()`. */
export async function buildApp(config: AppConfig, options: BuildAppOptions = {}) {
  const app = Fastify({ logger: loggerOptions(config) }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  // Before CORS, so a rejected request never gets as far as a CORS answer.
  registerSecurity(app, config);

  const runtime = createWorkflowRuntime({
    dataDir: config.dataDir,
    workflows: options.workflows ?? REGISTERED_WORKFLOWS,
    logger: app.log,
  });
  app.decorate('workflowRuntime', runtime);
  // Recovery runs once, before the server accepts requests.
  app.addHook('onReady', (done) => {
    try {
      const report = runtime.engine.recover();
      app.log.info(
        {
          databasePath: runtime.databasePath,
          workflows: runtime.registry.list().map((w) => `${w.id}@${w.version}`),
          resumed: report.resumed.length,
          interrupted: report.interrupted.length,
        },
        'Workflow runtime ready',
      );
      done();
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
  });
  app.addHook('onClose', async () => {
    await runtime.close();
  });

  await app.register(cors, {
    origin: [...config.allowedOrigins],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
  });

  await app.register(healthRoutes, { version: APP_VERSION });
  await app.register(workflowRoutes, { runtime });
  await app.register(executionRoutes, { runtime });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
