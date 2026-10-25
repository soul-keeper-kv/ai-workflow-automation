import type { ExecutionDetail, StepRun, WorkflowStateDto } from '@aap/shared';
import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  Hourglass,
  LoaderCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type Phase =
  'done' | 'running' | 'waiting' | 'failed' | 'interrupted' | 'current' | 'upcoming' | 'skipped';

const ICONS: Record<Phase, typeof CircleCheck> = {
  done: CircleCheck,
  running: LoaderCircle,
  waiting: Hourglass,
  failed: CircleX,
  interrupted: CircleSlash,
  current: CircleDot,
  upcoming: CircleDashed,
  skipped: CircleDashed,
};

const COLORS: Record<Phase, string> = {
  done: 'text-emerald-600 dark:text-emerald-400',
  running: 'text-blue-600 dark:text-blue-400 animate-spin',
  waiting: 'text-amber-600 dark:text-amber-400',
  failed: 'text-red-600 dark:text-red-400',
  interrupted: 'text-orange-600 dark:text-orange-400',
  current: 'text-blue-600 dark:text-blue-400',
  upcoming: 'text-muted-foreground',
  skipped: 'text-muted-foreground',
};

function latestRun(steps: readonly StepRun[], stepId: string): StepRun | undefined {
  return steps.filter((step) => step.stepId === stepId).at(-1);
}

function phaseOf(execution: ExecutionDetail, state: WorkflowStateDto): Phase {
  const isCurrent = execution.currentState === state.name;
  if (state.kind === 'final') return isCurrent ? 'done' : 'skipped';
  if (state.kind === 'approval') {
    if (isCurrent) return execution.status === 'WAITING_FOR_APPROVAL' ? 'waiting' : 'current';
    const decided = execution.approvals.some(
      (approval) =>
        approval.state === state.name &&
        (approval.status === 'APPROVED' || approval.status === 'REJECTED'),
    );
    return decided ? 'done' : 'upcoming';
  }
  const run = latestRun(execution.steps, state.name);
  if (run?.status === 'RUNNING') return 'running';
  if (isCurrent && run?.status === 'FAILED') {
    return execution.status === 'RUNNING' ? 'running' : 'failed'; // RUNNING: retry pending
  }
  if (isCurrent && run?.status === 'INTERRUPTED') return 'interrupted';
  if (isCurrent) return 'current';
  if (run?.status === 'SUCCEEDED') return 'done';
  return 'upcoming';
}

/**
 * The workflow's states in definition order. Final states the execution did not reach are
 * left out: a workflow takes one path per run, and listing every possible ending would only
 * confuse.
 */
export function StepTimeline({ execution }: { execution: ExecutionDetail }) {
  const rows = execution.states
    .map((state) => ({ state, phase: phaseOf(execution, state) }))
    .filter(({ state, phase }) => state.kind !== 'final' || phase === 'done');

  return (
    <ol className="flex flex-col gap-2" aria-label="Workflow progress">
      {rows.map(({ state, phase }) => {
        const Icon = ICONS[phase];
        const attempts = execution.steps.filter((step) => step.stepId === state.name).length;
        return (
          <li key={state.name} className="flex items-center gap-3 text-sm" data-phase={phase}>
            <Icon className={cn('size-4 shrink-0', COLORS[phase])} aria-hidden />
            <span className={cn(phase === 'upcoming' && 'text-muted-foreground')}>
              {state.title}
            </span>
            {attempts > 1 ? (
              <span className="text-xs text-muted-foreground">{attempts} attempts</span>
            ) : null}
            {phase === 'waiting' ? (
              <span className="text-xs text-amber-700 dark:text-amber-300">waiting for you</span>
            ) : null}
            <span className="sr-only">{phase}</span>
          </li>
        );
      })}
    </ol>
  );
}
