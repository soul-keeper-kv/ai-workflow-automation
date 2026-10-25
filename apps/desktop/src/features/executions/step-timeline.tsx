import type { ExecutionDetail, StepRun } from '@aap/shared';
import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  LoaderCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type Phase = 'done' | 'running' | 'failed' | 'interrupted' | 'current' | 'upcoming' | 'skipped';

const ICONS: Record<Phase, typeof CircleCheck> = {
  done: CircleCheck,
  running: LoaderCircle,
  failed: CircleX,
  interrupted: CircleSlash,
  current: CircleDot,
  upcoming: CircleDashed,
  skipped: CircleDashed,
};

const COLORS: Record<Phase, string> = {
  done: 'text-emerald-600 dark:text-emerald-400',
  running: 'text-blue-600 dark:text-blue-400 animate-spin',
  failed: 'text-red-600 dark:text-red-400',
  interrupted: 'text-orange-600 dark:text-orange-400',
  current: 'text-blue-600 dark:text-blue-400',
  upcoming: 'text-muted-foreground',
  skipped: 'text-muted-foreground',
};

function latestRun(steps: readonly StepRun[], stepId: string): StepRun | undefined {
  return steps.filter((step) => step.stepId === stepId).at(-1);
}

function phaseOf(execution: ExecutionDetail, name: string, kind: 'step' | 'final'): Phase {
  if (kind === 'final') return execution.currentState === name ? 'done' : 'skipped';
  const run = latestRun(execution.steps, name);
  if (run?.status === 'RUNNING') return 'running';
  if (run?.status === 'FAILED') return 'failed';
  if (run?.status === 'INTERRUPTED') return 'interrupted';
  if (execution.currentState === name) return 'current';
  if (run?.status === 'SUCCEEDED') return 'done';
  return 'upcoming';
}

/**
 * The workflow's states in definition order. Final states the execution did not reach are
 * left out: a workflow has one path per run, and showing every ending would only confuse.
 */
export function StepTimeline({ execution }: { execution: ExecutionDetail }) {
  const rows = execution.states
    .map((state) => ({ state, phase: phaseOf(execution, state.name, state.kind) }))
    .filter(({ state, phase }) => state.kind === 'step' || phase === 'done');

  return (
    <ol className="flex flex-col gap-2" aria-label="Workflow progress">
      {rows.map(({ state, phase }) => {
        const Icon = ICONS[phase];
        const run = latestRun(execution.steps, state.name);
        return (
          <li key={state.name} className="flex items-center gap-3 text-sm" data-phase={phase}>
            <Icon className={cn('size-4 shrink-0', COLORS[phase])} aria-hidden />
            <span className={cn(phase === 'upcoming' && 'text-muted-foreground')}>
              {state.title}
            </span>
            {run !== undefined && run.attempt > 1 ? (
              <span className="text-xs text-muted-foreground">attempt {run.attempt}</span>
            ) : null}
            <span className="sr-only">{phase}</span>
          </li>
        );
      })}
    </ol>
  );
}
