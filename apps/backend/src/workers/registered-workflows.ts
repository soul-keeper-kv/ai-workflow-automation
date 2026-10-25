import type { WorkflowRequirement } from '@aap/shared';
import type { Workflow } from '@aap/workflow-core';
import { demoSequenceWorkflow } from '@aap/workflow-demo';
import { createGenerateSpecWorkflow } from '@aap/workflow-generate-spec';
import type { Integrations } from './integrations.js';

export interface Availability {
  available: boolean;
  /** Why it cannot start right now, in words the user can act on. */
  reason: string | null;
}

export interface RegisteredWorkflow {
  workflow: Workflow;
  requirements: readonly WorkflowRequirement[];
  availability(): Availability;
}

const AVAILABLE: Availability = { available: true, reason: null };

/**
 * Every workflow this app can run, in catalog order. An explicit list, so registration is the
 * same on every start and nothing is loaded from disk or from API input. A workflow whose
 * integrations are missing is still registered, so its history stays readable, but it cannot
 * be started.
 */
export function createRegisteredWorkflows(integrations: Integrations): RegisteredWorkflow[] {
  return [
    {
      workflow: createGenerateSpecWorkflow({
        filesystem: integrations.filesystem,
        codingAgent: integrations.codingAgent,
      }),
      requirements: ['workspace', 'coding-agent'],
      availability: () => {
        if (integrations.workspaceRoots.length === 0) {
          return {
            available: false,
            reason: 'No workspace folder is allowed. Set AAP_WORKSPACE_ROOTS and restart.',
          };
        }
        const agent = integrations.codingAgentInfo;
        return agent.available
          ? AVAILABLE
          : { available: false, reason: `${agent.displayName}: ${agent.reason ?? 'unavailable'}` };
      },
    },
    { workflow: demoSequenceWorkflow, requirements: [], availability: () => AVAILABLE },
  ];
}
