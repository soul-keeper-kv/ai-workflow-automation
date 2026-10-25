import cors from '@fastify/cors';
import type { CodingAgent } from '@aap/integrations';
import Fastify, { LogController, type FastifyServerOptions } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { healthRoutes } from './api/health.js';
import type { AppConfig } from './config/env.js';
import { executionRoutes } from './modules/executions/execution-routes.js';
import { integrationRoutes } from './modules/integrations/integration-routes.js';
import { workflowRoutes } from './modules/workflows/workflow-routes.js';
import { registerErrorHandling } from './plugins/error-handler.js';
import { registerSecurity } from './plugins/security.js';
import { APP_VERSION } from './version.js';
import { createIntegrations } from './workers/integrations.js';
import { createRegisteredWorkflows } from './workers/registered-workflows.js';
import { createWorkflowRuntime } from './workers/workflow-runtime.js';

/** Where JSON log lines go. Tests pass one to read the logs. */
export interface LogDestination {
  write(line: string): void;
}

function loggerOptions(
  config: AppConfig,
  destination: LogDestination | undefined,
): FastifyServerOptions['logger'] {
  return {
    level: config.logLevel,
    // Defence in depth: nothing logs headers today, and these must never appear if one does.
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.apiToken', '*.token'],
      censor: '[redacted]',
    },
    ...(destination !== undefined
      ? { stream: destination }
      : config.logFormat === 'pretty'
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
  /** Replaces the configured coding agent. Tests use it to script answers. */
  codingAgent?: CodingAgent;
  logDestination?: LogDestination;
}

/** Builds the app without listening, so tests can drive it with `app.inject()`. */
export async function buildApp(config: AppConfig, options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: loggerOptions(config, options.logDestination),
    // Replaced by the onResponse hook below: the UI polls every second, and logging every
    // successful GET at info level would bury everything else.
    logController: new LogController({ disableRequestLogging: true }),
  }).withTypeProvider<ZodTypeProvider>();

  app.addHook('onResponse', (request, reply, done) => {
    const status = reply.statusCode;
    const level =
      status >= 500
        ? 'error'
        : status >= 400
          ? 'warn'
          : request.method === 'GET'
            ? 'debug'
            : 'info';
    request.log[level](
      {
        method: request.method,
        // The route pattern, not the raw URL: query strings never reach the logs.
        route: request.routeOptions.url ?? '(unmatched)',
        statusCode: status,
        durationMs: Math.round(reply.elapsedTime),
      },
      'Request completed',
    );
    done();
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  // Before CORS, so a rejected request never gets as far as a CORS answer.
  registerSecurity(app, config);

  const integrations = await createIntegrations(config, app.log);
  if (options.codingAgent !== undefined) {
    integrations.codingAgent = options.codingAgent;
    integrations.codingAgentInfo = await options.codingAgent.probe();
  }
  const runtime = createWorkflowRuntime({
    dataDir: config.dataDir,
    workflows: createRegisteredWorkflows(integrations),
    integrations,
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
  await app.register(integrationRoutes, { runtime });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
