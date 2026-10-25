import type { WorkflowStateDto, WorkflowSummary } from '@aap/shared';
import type { StateInfo, Workflow } from '@aap/workflow-core';

export function toStateDto(state: StateInfo): WorkflowStateDto {
  return {
    name: state.name,
    kind: state.kind,
    title: state.title,
    finalStatus: state.finalStatus,
  };
}

export function toWorkflowSummary(workflow: Workflow): WorkflowSummary {
  return {
    id: workflow.id,
    version: workflow.version,
    name: workflow.name,
    description: workflow.description,
    category: workflow.category,
    // Every registered workflow can run today. Workflows that need an integration (a coding
    // agent, Jira, ...) will report it here once those exist.
    availability: { available: true, reason: null },
    inputSchema: workflow.inputJsonSchema,
    states: workflow.states.map(toStateDto),
  };
}
