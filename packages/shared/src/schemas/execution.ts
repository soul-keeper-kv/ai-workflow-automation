import { z } from 'zod';

/**
 * Lifecycle of one execution. It says where the execution is in its life, not which business
 * step it is on; that is the workflow's own machine state (`currentState`).
 */
export const EXECUTION_STATUSES = [
  'PENDING',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  /** Stopped in a way the platform cannot safely continue alone. Needs a person to decide. */
  'INTERRUPTED',
  'FAILED',
  'CANCELLED',
  'COMPLETED',
] as const;

export const executionStatusSchema = z.enum(EXECUTION_STATUSES);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const TERMINAL_EXECUTION_STATUSES = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const satisfies readonly ExecutionStatus[];

/** One attempt at running one step. */
export const STEP_RUN_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED'] as const;

export const stepRunStatusSchema = z.enum(STEP_RUN_STATUSES);
export type StepRunStatus = z.infer<typeof stepRunStatusSchema>;

export const EXECUTION_EVENT_TYPES = [
  'EXECUTION_CREATED',
  'STATUS_CHANGED',
  'STEP_STARTED',
  'STEP_SUCCEEDED',
  'STEP_FAILED',
  'STEP_INTERRUPTED',
  'STATE_CHANGED',
] as const;

export const executionEventTypeSchema = z.enum(EXECUTION_EVENT_TYPES);
export type ExecutionEventType = z.infer<typeof executionEventTypeSchema>;
