import { z } from 'zod';
import { workflowIdSchema, workflowStateSchema } from './execution.js';

/** `workspace`: reads or writes files in allowed folders. `coding-agent`: sends code to an AI agent. */
export const WORKFLOW_REQUIREMENTS = ['workspace', 'coding-agent'] as const;
export type WorkflowRequirement = (typeof WORKFLOW_REQUIREMENTS)[number];

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
  /** What the workflow needs from this machine; the UI explains what each one implies. */
  requirements: z.array(z.enum(WORKFLOW_REQUIREMENTS)),
  /** JSON Schema (draft 2020-12) of the input. The server still validates every request. */
  inputSchema: z.record(z.string(), z.unknown()),
  states: z.array(workflowStateSchema),
});

export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

export const workflowIdParamsSchema = z.object({ workflowId: workflowIdSchema });

export const listWorkflowsResponseSchema = z.object({ workflows: z.array(workflowSummarySchema) });

export const workflowResponseSchema = z.object({ workflow: workflowSummarySchema });
