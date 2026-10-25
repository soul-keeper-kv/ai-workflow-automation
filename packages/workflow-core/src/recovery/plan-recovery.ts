import { ENGINE_ERROR_CODES } from '../contracts/errors.js';
import type { ErrorInfo, ExecutionRecord, StepRunRecord } from '../persistence/execution-store.js';

export type RecoveryPlan = { action: 'resume' } | { action: 'interrupt'; error: ErrorInfo };

/**
 * Decides what to do at startup with an execution that was PENDING or RUNNING when the
 * previous process stopped. Conservative by design:
 * - No step was running: every completed step committed its transition atomically, so the
 *   execution is exactly between steps and can continue.
 * - A step was running: it may have had side effects (edited files, finished a test run
 *   without the result being saved). It is not re-run; a person decides.
 */
export function planRecovery(
  _execution: Pick<ExecutionRecord, 'status'>,
  runningStep: Pick<StepRunRecord, 'stepId'> | null,
): RecoveryPlan {
  if (runningStep === null) return { action: 'resume' };
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
