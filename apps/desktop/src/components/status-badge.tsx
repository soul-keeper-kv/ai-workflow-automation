import type { ExecutionStatus, StepRunStatus } from '@aap/shared';
import { STATUS_LABELS } from '@/lib/execution-status';
import { cn } from '@/lib/utils';

const STATUS_CLASSES: Record<ExecutionStatus, string> = {
  PENDING: 'bg-muted text-muted-foreground',
  RUNNING: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  WAITING_FOR_APPROVAL: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  INTERRUPTED: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  FAILED: 'bg-red-500/15 text-red-700 dark:text-red-300',
  CANCELLED: 'bg-muted text-muted-foreground',
  COMPLETED: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
};

const STEP_CLASSES: Record<StepRunStatus, string> = {
  RUNNING: STATUS_CLASSES.RUNNING,
  SUCCEEDED: STATUS_CLASSES.COMPLETED,
  FAILED: STATUS_CLASSES.FAILED,
  INTERRUPTED: STATUS_CLASSES.INTERRUPTED,
};

const STEP_LABELS: Record<StepRunStatus, string> = {
  RUNNING: 'Running',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  INTERRUPTED: 'Interrupted',
};

const base =
  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';

export function StatusBadge({ status }: { status: ExecutionStatus }) {
  return (
    <span className={cn(base, STATUS_CLASSES[status])} data-status={status}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function StepStatusBadge({ status }: { status: StepRunStatus }) {
  return <span className={cn(base, STEP_CLASSES[status])}>{STEP_LABELS[status]}</span>;
}
