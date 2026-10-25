import { TERMINAL_EXECUTION_STATUSES, type ExecutionStatus } from '@aap/shared';
import { InvalidStatusTransitionError } from '../contracts/errors.js';

/** The only lifecycle moves allowed. Anything else is a bug and is rejected, not applied. */
const ALLOWED_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  PENDING: ['RUNNING', 'CANCELLED', 'FAILED', 'INTERRUPTED'],
  RUNNING: ['WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  WAITING_FOR_APPROVAL: ['RUNNING', 'CANCELLED', 'FAILED', 'INTERRUPTED'],
  INTERRUPTED: ['RUNNING', 'CANCELLED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionStatus(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertStatusTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  if (!canTransitionStatus(from, to)) throw new InvalidStatusTransitionError(from, to);
}

export function isTerminalStatus(status: ExecutionStatus): boolean {
  return (TERMINAL_EXECUTION_STATUSES as readonly ExecutionStatus[]).includes(status);
}
