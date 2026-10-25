import cors from '@fastify/cors';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { healthRoutes } from './api/health.js';
import type { AppConfig } from './config/env.js';
import { registerErrorHandling } from './plugins/error-handler.js';
import { APP_VERSION } from './version.js';

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

/** Builds the app without listening, so tests can drive it with `app.inject()`. */
export async function buildApp(config: AppConfig) {
  const app = Fastify({ logger: loggerOptions(config) }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  await app.register(cors, {
    origin: [...config.allowedOrigins],
    methods: ['GET', 'POST'],
  });

  await app.register(healthRoutes, { version: APP_VERSION });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
