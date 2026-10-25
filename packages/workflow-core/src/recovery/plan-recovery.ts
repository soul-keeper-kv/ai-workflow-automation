import { ENGINE_ERROR_CODES } from '../contracts/errors.js';
import type { RecoveryPolicy } from '../contracts/workflow.js';
import type { ErrorInfo, ExecutionRecord, StepRunRecord } from '../persistence/execution-store.js';

export type RecoveryPlan =
  | { action: 'resume' }
  /** Close the stale attempt as INTERRUPTED, then run the step again. */
  | { action: 'rerun'; note: ErrorInfo }
  | { action: 'interrupt'; error: ErrorInfo };

/**
 * Decides what to do at startup with an execution that was PENDING or RUNNING when the
 * previous process stopped. Conservative by design:
 * - No step was running: every completed step committed its transition atomically, so the
 *   execution is exactly between steps and can continue.
 * - A step was running and declares `recovery: 'rerun'` (no side effects, or idempotent): it
 *   runs again.
 * - A step was running otherwise (`manual`, the default, or its workflow is gone): it may have
 *   had side effects, such as edited files or a test run whose result was never saved. It is
 *   not re-run; a person decides.
 */
export function planRecovery(
  _execution: Pick<ExecutionRecord, 'status'>,
  runningStep: Pick<StepRunRecord, 'stepId'> | null,
  recovery: RecoveryPolicy | null,
): RecoveryPlan {
  if (runningStep === null) return { action: 'resume' };
  if (recovery === 'rerun') {
    return {
      action: 'rerun',
      note: {
        code: ENGINE_ERROR_CODES.interrupted,
        message: `The app stopped during this attempt. "${runningStep.stepId}" is safe to re-run, so it runs again.`,
      },
    };
  }
  return {
    action: 'interrupt',
    error: {
      code: ENGINE_ERROR_CODES.interrupted,
      message:
        `The app stopped while step "${runningStep.stepId}" was running. ` +
        'It was not re-run, because it may already have had side effects.',
    },
  };
}
