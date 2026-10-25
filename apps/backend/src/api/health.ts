import { healthResponseSchema } from '@aap/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

export interface HealthRoutesOptions {
  version: string;
}

export const healthRoutes: FastifyPluginCallbackZod<HealthRoutesOptions> = (app, options, done) => {
  app.get('/health', { schema: { response: { 200: healthResponseSchema } } }, () => ({
    status: 'ok' as const,
    version: options.version,
    uptimeSeconds: Math.floor(process.uptime()),
  }));
  done();
};
