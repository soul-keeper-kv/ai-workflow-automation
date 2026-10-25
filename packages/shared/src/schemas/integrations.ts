import { z } from 'zod';

export const codingAgentInfoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  available: z.boolean(),
  version: z.string().nullable(),
  reason: z.string().nullable(),
  /** Where the user's code goes when this agent runs (blueprint §10.3). Always shown. */
  dataNotice: z.string(),
});

export type CodingAgentInfoDto = z.infer<typeof codingAgentInfoSchema>;

export const integrationsResponseSchema = z.object({
  codingAgent: codingAgentInfoSchema,
  /** The only folders workflows may read and write. */
  workspaceRoots: z.array(z.string()),
});

export type IntegrationsResponse = z.infer<typeof integrationsResponseSchema>;
