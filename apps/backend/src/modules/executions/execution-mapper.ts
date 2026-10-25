import type { ExecutionDetail, ExecutionEvent, ExecutionSummary, StepRun } from '@aap/shared';
import type {
  ExecutionEventRecord,
  ExecutionRecord,
  ExecutionSummaryRecord,
  StepRunRecord,
} from '@aap/workflow-core';
import type { WorkflowRuntime } from '../../workers/workflow-runtime.js';
import { toStateDto } from '../workflows/workflow-mapper.js';

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date === null ? null : date.toISOString());

export function toExecutionSummary(
  record: ExecutionSummaryRecord,
  runtime: WorkflowRuntime,
): ExecutionSummary {
  const workflow = runtime.registry.get(record.workflowId);
  return {
    id: record.id,
    workflowId: record.workflowId,
    workflowVersion: record.workflowVersion,
    workflowName: workflow?.name ?? record.workflowId,
    status: record.status,
    currentState: record.currentState,
    currentStateTitle: workflow?.getState(record.currentState)?.title ?? record.currentState,
    error: record.error,
    cancelRequested: runtime.engine.isCancelRequested(record.id),
    createdAt: iso(record.createdAt),
    startedAt: isoOrNull(record.startedAt),
    updatedAt: iso(record.updatedAt),
    completedAt: isoOrNull(record.completedAt),
  };
}

function toStepRun(record: StepRunRecord, runtime: WorkflowRuntime, workflowId: string): StepRun {
  return {
    id: record.id,
    stepId: record.stepId,
    title: runtime.registry.get(workflowId)?.getState(record.stepId)?.title ?? record.stepId,
    status: record.status,
    attempt: record.attempt,
    error: record.error,
    startedAt: iso(record.startedAt),
    completedAt: isoOrNull(record.completedAt),
    durationMs:
      record.completedAt === null
        ? null
        : record.completedAt.getTime() - record.startedAt.getTime(),
  };
}

export function toExecutionDetail(
  record: ExecutionRecord,
  runtime: WorkflowRuntime,
): ExecutionDetail {
  const workflow = runtime.registry.get(record.workflowId);
  return {
    ...toExecutionSummary(record, runtime),
    input: record.input,
    output: record.output,
    states: workflow?.states.map(toStateDto) ?? [],
    steps: runtime.store
      .listStepRuns(record.id)
      .map((step) => toStepRun(step, runtime, record.workflowId)),
  };
}

export function toExecutionEvent(record: ExecutionEventRecord): ExecutionEvent {
  return {
    id: record.id,
    type: record.type,
    stateBefore: record.stateBefore,
    stateAfter: record.stateAfter,
    payload: record.payload,
    createdAt: iso(record.createdAt),
  };
}
