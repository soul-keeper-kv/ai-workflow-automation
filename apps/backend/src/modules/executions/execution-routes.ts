import {
  cancelExecutionResponseSchema,
  executionIdParamsSchema,
  executionResponseSchema,
  executionStatsResponseSchema,
  listEventsQuerySchema,
  listEventsResponseSchema,
  listExecutionsQuerySchema,
  listExecutionsResponseSchema,
  startExecutionRequestSchema,
} from '@aap/shared';
import { ExecutionNotFoundError, type ExecutionRecord } from '@aap/workflow-core';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import type { WorkflowRuntime } from '../../workers/workflow-runtime.js';
import { toExecutionDetail, toExecutionEvent, toExecutionSummary } from './execution-mapper.js';

const RECENTLY_FINISHED = 5;

export const executionRoutes: FastifyPluginCallbackZod<{ runtime: WorkflowRuntime }> = (
  app,
  { runtime },
  done,
) => {
  const { engine, store } = runtime;

  const requireExecution = (id: string): ExecutionRecord => {
    const execution = store.getExecution(id);
    if (execution === undefined) throw new ExecutionNotFoundError(id);
    return execution;
  };

  app.post(
    '/api/executions',
    { schema: { body: startExecutionRequestSchema, response: { 201: executionResponseSchema } } },
    (request, reply) => {
      // Returns as soon as the execution is persisted; steps run in the engine, not here.
      const execution = engine.start(request.body.workflowId, request.body.input);
      reply.code(201);
      return { execution: toExecutionDetail(execution, runtime) };
    },
  );

  app.get(
    '/api/executions',
    {
      schema: {
        querystring: listExecutionsQuerySchema,
        response: { 200: listExecutionsResponseSchema },
      },
    },
    (request) => {
      const { workflowId, status, limit, offset } = request.query;
      return {
        executions: store
          .listExecutionSummaries({ workflowId, status, limit, offset })
          .map((execution) => toExecutionSummary(execution, runtime)),
        total: store.countExecutions({ workflowId, status }),
      };
    },
  );

  app.get(
    '/api/executions/stats',
    { schema: { response: { 200: executionStatsResponseSchema } } },
    () => {
      const byStatus = store.countByStatus();
      return {
        total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
        byStatus,
        recentlyFinished: store
          .listRecentlyFinished(RECENTLY_FINISHED)
          .map((execution) => toExecutionSummary(execution, runtime)),
      };
    },
  );

  app.get(
    '/api/executions/:executionId',
    { schema: { params: executionIdParamsSchema, response: { 200: executionResponseSchema } } },
    (request) => ({
      execution: toExecutionDetail(requireExecution(request.params.executionId), runtime),
    }),
  );

  app.post(
    '/api/executions/:executionId/cancel',
    {
      schema: {
        params: executionIdParamsSchema,
        response: { 200: cancelExecutionResponseSchema, 202: cancelExecutionResponseSchema },
      },
    },
    (request, reply) => {
      const { outcome, execution } = engine.cancel(request.params.executionId);
      reply.code(outcome === 'cancelled' ? 200 : 202);
      return { outcome, execution: toExecutionDetail(execution, runtime) };
    },
  );

  app.get(
    '/api/executions/:executionId/events',
    {
      schema: {
        params: executionIdParamsSchema,
        querystring: listEventsQuerySchema,
        response: { 200: listEventsResponseSchema },
      },
    },
    (request) => {
      const { executionId } = request.params;
      requireExecution(executionId);
      return {
        events: store
          .listEvents(executionId, { afterId: request.query.after, limit: request.query.limit })
          .map(toExecutionEvent),
      };
    },
  );

  done();
};
