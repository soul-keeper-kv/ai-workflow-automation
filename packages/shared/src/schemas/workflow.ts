import { z } from 'zod';
import { workflowIdSchema, workflowStateSchema } from './execution.js';

export const workflowSummarySchema = z.object({
  id: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  availability: z.object({
    available: z.boolean(),
    /** Why the workflow cannot be started right now, e.g. a missing integration. */
    reason: z.string().nullable(),
  }),
  /** JSON Schema (draft 2020-12) of the input. The server still validates every request. */
  inputSchema: z.record(z.string(), z.unknown()),
  states: z.array(workflowStateSchema),
});

export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

export const workflowIdParamsSchema = z.object({ workflowId: workflowIdSchema });

export const listWorkflowsResponseSchema = z.object({ workflows: z.array(workflowSummarySchema) });

export const workflowResponseSchema = z.object({ workflow: workflowSummarySchema });
