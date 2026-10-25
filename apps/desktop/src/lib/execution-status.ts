import { TERMINAL_EXECUTION_STATUSES, type ExecutionStatus } from '@aap/shared';

/** Display-only mapping. Which transitions are allowed is decided by the backend, never here. */
export const STATUS_LABELS: Record<ExecutionStatus, string> = {
  PENDING: 'Pending',
  RUNNING: 'Running',
  WAITING_FOR_APPROVAL: 'Awaiting approval',
  INTERRUPTED: 'Interrupted',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  COMPLETED: 'Completed',
};

export function isFinished(status: ExecutionStatus): boolean {
  return (TERMINAL_EXECUTION_STATUSES as readonly ExecutionStatus[]).includes(status);
}

/** Statuses whose data still changes on its own, so screens keep polling. */
export function isLive(status: ExecutionStatus): boolean {
  return status === 'PENDING' || status === 'RUNNING';
}
