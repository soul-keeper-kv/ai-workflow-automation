'use client';

import type { ExecutionDetail, ExecutionEvent } from '@aap/shared';
import { ArrowLeft, CircleAlert, OctagonX } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { JsonBlock } from '@/components/json-block';
import { EmptyState, ErrorAlert, LoadingBlock } from '@/components/query-states';
import { StatusBadge, StepStatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCancelExecution, useExecution, useExecutionEvents } from '@/hooks/use-api';
import { useNow } from '@/hooks/use-now';
import { isFinished, isLive } from '@/lib/execution-status';
import { elapsedMs, formatDateTime, formatDuration } from '@/lib/format';
import { ApprovalHistory, ApprovalPanel } from './approval-panel';
import { ResumePanel } from './resume-panel';
import { StepTimeline } from './step-timeline';

const RECENT_EVENTS = 25;

function CancelButton({ execution }: { execution: ExecutionDetail }) {
  const cancel = useCancelExecution();
  const [confirming, setConfirming] = useState(false);

  if (isFinished(execution.status)) return null;
  if (execution.cancelRequested) {
    return (
      <Button variant="outline" size="sm" disabled>
        Cancelling…
      </Button>
    );
  }
  if (!confirming) {
    return (
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
        <OctagonX aria-hidden />
        Cancel
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="destructive"
        size="sm"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate(execution.id, { onSettled: () => setConfirming(false) })}
      >
        Confirm cancel
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        Keep running
      </Button>
      {cancel.isError ? (
        <span className="text-xs text-destructive">{cancel.error.message}</span>
      ) : null}
    </div>
  );
}

/** Payload values are untrusted JSON: print primitives as they are, anything else as JSON. */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value === undefined || value === null ? '?' : JSON.stringify(value);
}

function describeEvent(event: ExecutionEvent): string {
  const payload =
    typeof event.payload === 'object' && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : {};
  switch (event.type) {
    case 'STATUS_CHANGED':
      return `${text(payload.from)} → ${text(payload.to)}`;
    case 'STATE_CHANGED':
      return `${event.stateBefore ?? '?'} → ${event.stateAfter ?? '?'} (${text(payload.event)})`;
    case 'STEP_STARTED':
    case 'STEP_SUCCEEDED':
    case 'STEP_FAILED':
    case 'STEP_INTERRUPTED':
      return `${text(payload.stepId)} · attempt ${text(payload.attempt)}${
        payload.errorCode === undefined ? '' : ` · ${text(payload.errorCode)}`
      }`;
    default:
      return event.stateAfter ?? event.stateBefore ?? '';
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function Monitor({ execution }: { execution: ExecutionDetail }) {
  const live = isLive(execution.status);
  const now = useNow(1_000, live);
  const events = useExecutionEvents(execution.id, live, execution.updatedAt);
  const recent = (events.data?.events ?? []).slice(-RECENT_EVENTS).reverse();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {execution.workflowName}
            <StatusBadge status={execution.status} />
          </span>
        }
        description={<span className="font-mono text-xs">{execution.id}</span>}
        actions={
          <>
            <CancelButton execution={execution} />
            <Link href="/executions" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <ArrowLeft aria-hidden />
              History
            </Link>
          </>
        }
      />

      {execution.error === null ? null : (
        <Alert variant={execution.status === 'INTERRUPTED' ? 'default' : 'destructive'}>
          <CircleAlert aria-hidden />
          <AlertTitle>{execution.error.code}</AlertTitle>
          <AlertDescription>{execution.error.message}</AlertDescription>
        </Alert>
      )}

      {execution.status === 'INTERRUPTED' ? <ResumePanel execution={execution} /> : null}

      {execution.status === 'WAITING_FOR_APPROVAL' && execution.pendingApproval !== null ? (
        <ApprovalPanel execution={execution} approval={execution.pendingApproval} />
      ) : null}

      <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Field label="Current step">{execution.currentStateTitle}</Field>
        <Field label="Started">{formatDateTime(execution.startedAt)}</Field>
        <Field label="Duration">
          {formatDuration(elapsedMs(execution.startedAt, execution.completedAt, now))}
        </Field>
        <Field label="Workflow version">
          <span className="font-mono">{execution.workflowVersion}</span>
        </Field>
      </dl>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <StepTimeline execution={execution} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Step attempts</CardTitle>
          </CardHeader>
          <CardContent>
            {execution.steps.length === 0 ? (
              <p className="text-sm text-muted-foreground">No step has started yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Step</TableHead>
                    <TableHead>Attempt</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {execution.steps.map((step) => (
                    <TableRow key={step.id}>
                      <TableCell>{step.title}</TableCell>
                      <TableCell>{step.attempt}</TableCell>
                      <TableCell>
                        <StepStatusBadge status={step.status} />
                      </TableCell>
                      <TableCell>
                        {formatDuration(
                          step.durationMs ?? elapsedMs(step.startedAt, step.completedAt, now),
                        )}
                      </TableCell>
                      <TableCell className="max-w-64 truncate text-xs text-muted-foreground">
                        {step.error === null ? '—' : `${step.error.code}: ${step.error.message}`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <ApprovalHistory approvals={execution.approvals} />

      {execution.output === null ? null : (
        <Card>
          <CardHeader>
            <CardTitle>Output</CardTitle>
          </CardHeader>
          <CardContent>
            <JsonBlock value={execution.output} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent events</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events yet.</p>
          ) : (
            <ol className="flex flex-col gap-1 font-mono text-xs" aria-label="Recent events">
              {recent.map((event) => (
                <li key={event.id} className="flex gap-3">
                  <span className="text-muted-foreground">{formatDateTime(event.createdAt)}</span>
                  <span className="font-medium">{event.type}</span>
                  <span className="text-muted-foreground">{describeEvent(event)}</span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer text-sm font-medium">Input</summary>
        <div className="mt-3">
          <JsonBlock value={execution.input} />
        </div>
      </details>
    </div>
  );
}

export function ExecutionMonitor() {
  const id = useSearchParams().get('id');
  const execution = useExecution(id);

  if (id === null) return <EmptyState title="No execution selected." />;
  if (execution.isPending) return <LoadingBlock rows={4} />;
  if (execution.isError) {
    return <ErrorAlert error={execution.error} onRetry={() => void execution.refetch()} />;
  }
  return <Monitor execution={execution.data.execution} />;
}
