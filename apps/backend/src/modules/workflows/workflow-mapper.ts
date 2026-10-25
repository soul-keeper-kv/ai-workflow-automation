import type { WorkflowRequirement, WorkflowStateDto, WorkflowSummary } from '@aap/shared';
import type { StateInfo, Workflow } from '@aap/workflow-core';

export function toStateDto(state: StateInfo): WorkflowStateDto {
  return {
    name: state.name,
    kind: state.kind,
    title: state.title,
    finalStatus: state.finalStatus,
    approvalType: state.approvalType,
  };
}

export function toWorkflowSummary(
  workflow: Workflow,
  availability: { available: boolean; reason: string | null },
  requirements: readonly WorkflowRequirement[],
): WorkflowSummary {
  return {
    id: workflow.id,
    version: workflow.version,
    name: workflow.name,
    description: workflow.description,
    category: workflow.category,
    availability,
    requirements: [...requirements],
    inputSchema: workflow.inputJsonSchema,
    states: workflow.states.map(toStateDto),
  };
}
