import {
  listWorkflowsResponseSchema,
  workflowIdParamsSchema,
  workflowResponseSchema,
} from '@aap/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import type { WorkflowRuntime } from '../../workers/workflow-runtime.js';
import { toWorkflowSummary } from './workflow-mapper.js';

export const workflowRoutes: FastifyPluginCallbackZod<{ runtime: WorkflowRuntime }> = (
  app,
  { runtime },
  done,
) => {
  app.get('/api/workflows', { schema: { response: { 200: listWorkflowsResponseSchema } } }, () => ({
    workflows: runtime.registry
      .list()
      .map((workflow) =>
        toWorkflowSummary(
          workflow,
          runtime.availability(workflow.id),
          runtime.requirements(workflow.id),
        ),
      ),
  }));

  app.get(
    '/api/workflows/:workflowId',
    { schema: { params: workflowIdParamsSchema, response: { 200: workflowResponseSchema } } },
    (request) => ({
      workflow: toWorkflowSummary(
        runtime.registry.require(request.params.workflowId),
        runtime.availability(request.params.workflowId),
        runtime.requirements(request.params.workflowId),
      ),
    }),
  );

  done();
};
