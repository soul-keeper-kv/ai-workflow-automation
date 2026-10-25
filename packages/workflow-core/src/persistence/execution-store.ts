import type {
  ApprovalStatus,
  ExecutionEventType,
  ExecutionStatus,
  StepRunStatus,
} from '@aap/shared';
import type { JsonValue } from '../contracts/json.js';

export interface ErrorInfo {
  code: string;
  message: string;
}

/** JSON fields are `unknown`: the reader validates them with the schema it knows. */
export interface ExecutionRecord {
  id: string;
  workflowId: string;
  workflowVersion: string;
  status: ExecutionStatus;
  currentState: string;
  input: unknown;
  context: unknown;
  output: unknown;
  error: ErrorInfo | null;
  revision: number;
  createdAt: Date;
  startedAt: Date | null;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface StepRunRecord {
  id: string;
  executionId: string;
  stepId: string;
  status: StepRunStatus;
  attempt: number;
  output: unknown;
  error: ErrorInfo | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface ExecutionEventRecord {
  id: number;
  executionId: string;
  type: ExecutionEventType;
  stateBefore: string | null;
  stateAfter: string | null;
  payload: unknown;
  createdAt: Date;
}

export interface ApprovalRecord {
  id: string;
  executionId: string;
  state: string;
  approvalType: string;
  status: ApprovalStatus;
  request: unknown;
  decision: unknown;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface NewExecution {
  id: string;
  workflowId: string;
  workflowVersion: string;
  currentState: string;
  input: JsonValue;
  context: JsonValue;
}

export interface NewExecutionEvent {
  type: Exclude<ExecutionEventType, 'STATUS_CHANGED'>;
  stateBefore?: string | null;
  stateAfter?: string | null;
  payload?: JsonValue;
}

/**
 * One atomic change to an execution: the execution row, at most one step run, and the
 * events that describe the change. Applied in a single transaction, or not at all.
 */
export interface ExecutionChange {
  executionId: string;
  /** The revision the caller read. The change is rejected if the row has moved on. */
  expectedRevision: number;
  execution?: {
    /**
     * Checked against the lifecycle rules. The store records a STATUS_CHANGED event, sets
     * `startedAt` on the first move to RUNNING and `completedAt` on a terminal status.
     */
    status?: ExecutionStatus;
    currentState?: string;
    context?: JsonValue;
    output?: JsonValue | null;
    error?: ErrorInfo | null;
  };
  startStepRun?: { id: string; stepId: string; attempt: number };
  finishStepRun?: {
    id: string;
    status: Exclude<StepRunStatus, 'RUNNING'>;
    output?: JsonValue;
    error?: ErrorInfo;
  };
  /** Opens a PENDING approval request. At most one can be pending per execution. */
  requestApproval?: { id: string; state: string; approvalType: string; request: JsonValue };
  /** Decides the pending request. Leaving WAITING_FOR_APPROVAL without one cancels it. */
  decideApproval?: { id: string; status: 'APPROVED' | 'REJECTED'; decision: JsonValue };
  events?: readonly NewExecutionEvent[];
}

/**
 * Durable state of executions. Every write goes through `createExecution` or `applyChange`,
 * so the lifecycle and concurrency rules are enforced in one place.
 */
export interface ExecutionStore {
  createExecution(execution: NewExecution): ExecutionRecord;
  applyChange(change: ExecutionChange): ExecutionRecord;
  getExecution(id: string): ExecutionRecord | undefined;
  listExecutionsByStatus(statuses: readonly ExecutionStatus[]): ExecutionRecord[];
  getRunningStepRun(executionId: string): StepRunRecord | undefined;
  countStepRuns(executionId: string, stepId: string): number;
  listStepRuns(executionId: string): StepRunRecord[];
  listEvents(
    executionId: string,
    options?: { afterId?: number; limit?: number },
  ): ExecutionEventRecord[];
  /** Newest first, without the JSON columns. */
  listExecutionSummaries(
    filter: ExecutionFilter & { limit: number; offset: number },
  ): ExecutionSummaryRecord[];
  countExecutions(filter: ExecutionFilter): number;
  countByStatus(): Record<ExecutionStatus, number>;
  /** Terminal executions, most recently completed first. */
  listRecentlyFinished(limit: number): ExecutionSummaryRecord[];
  getApproval(id: string): ApprovalRecord | undefined;
  getPendingApproval(executionId: string): ApprovalRecord | undefined;
  /** Oldest first. */
  listApprovals(executionId: string): ApprovalRecord[];
}

export interface ExecutionFilter {
  workflowId?: string | undefined;
  status?: ExecutionStatus | undefined;
}

export type ExecutionSummaryRecord = Omit<ExecutionRecord, 'input' | 'context' | 'output'>;
