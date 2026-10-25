import type { ExecutionStatus } from '@aap/shared';

/** Error codes the engine records on executions and step runs. Stable: the UI branches on them. */
export const ENGINE_ERROR_CODES = {
  /** A step threw without a more specific code. */
  stepFailed: 'STEP_FAILED',
  /** A step returned an event its state does not accept. */
  invalidTransition: 'INVALID_TRANSITION',
  /** The stored or computed state is not a state the workflow defines for this purpose. */
  invalidState: 'INVALID_STATE',
  /** Persisted or computed context does not match the workflow's context schema. */
  invalidContext: 'INVALID_CONTEXT',
  invalidOutput: 'INVALID_OUTPUT',
  /** The machine requested an action other than `assign`; the engine never runs those. */
  unsupportedMachineAction: 'UNSUPPORTED_MACHINE_ACTION',
  /** The execution's workflow (at its recorded version) is not registered. */
  workflowUnavailable: 'WORKFLOW_UNAVAILABLE',
  /** The app stopped while a step was running; the step was not re-run. */
  interrupted: 'INTERRUPTED',
  /** The user cancelled while the step was running. */
  cancelled: 'CANCELLED',
  stepTimeout: 'STEP_TIMEOUT',
  /** The machine reached a FAILED final state that names no code of its own. */
  workflowFailed: 'WORKFLOW_FAILED',
} as const;

export class WorkflowEngineError extends Error {
  override readonly name: string = 'WorkflowEngineError';

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Thrown by workflow steps to fail with a specific, stable code. */
export class StepError extends WorkflowEngineError {
  override readonly name = 'StepError';
  /** Only retryable errors are retried, and only when the step has a retry policy. */
  readonly retryable: boolean;

  constructor(message: string, options?: ErrorOptions & { code?: string; retryable?: boolean }) {
    super(options?.code ?? ENGINE_ERROR_CODES.stepFailed, message, options);
    this.retryable = options?.retryable ?? false;
  }
}

/** The abort reason when a step exceeds its timeout. */
export class StepTimeoutError extends WorkflowEngineError {
  override readonly name = 'StepTimeoutError';

  constructor(
    readonly timeoutMs: number,
    /** False when the step ignored the abort and may still be running. */
    readonly stopped: boolean,
  ) {
    super(
      ENGINE_ERROR_CODES.stepTimeout,
      stopped
        ? `The step did not finish within ${timeoutMs} ms.`
        : `The step did not finish within ${timeoutMs} ms and did not stop when asked; it may still be running.`,
    );
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class InputValidationError extends Error {
  override readonly name = 'InputValidationError';

  constructor(readonly issues: readonly ValidationIssue[]) {
    super(
      `Invalid workflow input: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
}

/** A workflow definition breaks the platform's rules. Raised at definition or registration time. */
export class WorkflowDefinitionError extends Error {
  override readonly name = 'WorkflowDefinitionError';
}

export class WorkflowNotFoundError extends Error {
  override readonly name = 'WorkflowNotFoundError';

  constructor(readonly workflowId: string) {
    super(`Workflow "${workflowId}" is not registered.`);
  }
}

export class ExecutionNotFoundError extends Error {
  override readonly name = 'ExecutionNotFoundError';

  constructor(readonly executionId: string) {
    super(`Execution "${executionId}" does not exist.`);
  }
}

export class InvalidStatusTransitionError extends Error {
  override readonly name = 'InvalidStatusTransitionError';

  constructor(
    readonly from: ExecutionStatus,
    readonly to: ExecutionStatus,
  ) {
    super(`An execution cannot go from ${from} to ${to}.`);
  }
}

/** Someone else changed the execution since it was read (optimistic concurrency). */
export class ConcurrentModificationError extends Error {
  override readonly name = 'ConcurrentModificationError';

  constructor(
    readonly executionId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Execution ${executionId} is at revision ${actualRevision}, expected ${expectedRevision}.`,
    );
  }
}

export class PayloadTooLargeError extends Error {
  override readonly name = 'PayloadTooLargeError';

  constructor(
    readonly field: string,
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`${field} is ${bytes} bytes; the limit is ${limit}.`);
  }
}

/** Data read back from the database is not what was written (corrupt or edited by hand). */
export class CorruptRecordError extends Error {
  override readonly name = 'CorruptRecordError';
}

/** The request is valid but the execution's current state does not allow it. */
export class ExecutionConflictError extends Error {
  override readonly name = 'ExecutionConflictError';

  constructor(
    readonly executionId: string,
    message: string,
  ) {
    super(message);
  }
}

export class ApprovalNotFoundError extends Error {
  override readonly name = 'ApprovalNotFoundError';

  constructor(
    readonly executionId: string,
    readonly approvalId: string,
  ) {
    super(`Approval "${approvalId}" does not exist for execution "${executionId}".`);
  }
}
