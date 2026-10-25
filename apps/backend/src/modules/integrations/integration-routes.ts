import { integrationsResponseSchema } from '@aap/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import type { WorkflowRuntime } from '../../workers/workflow-runtime.js';

/** Which AI integration is configured and which folders workflows may touch (§10.3). */
export const integrationRoutes: FastifyPluginCallbackZod<{ runtime: WorkflowRuntime }> = (
  app,
  { runtime },
  done,
) => {
  app.get(
    '/api/integrations',
    { schema: { response: { 200: integrationsResponseSchema } } },
    () => ({
      codingAgent: runtime.integrations.codingAgentInfo,
      workspaceRoots: [...runtime.integrations.workspaceRoots],
    }),
  );
  done();
};
