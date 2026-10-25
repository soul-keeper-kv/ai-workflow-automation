'use client';

import { EmptyState, ErrorAlert, LoadingBlock } from '@/components/query-states';
import { useExecutions } from '@/hooks/use-api';
import { ExecutionTable } from './execution-table';

export function PendingApprovals() {
  const waiting = useExecutions({ status: 'WAITING_FOR_APPROVAL', limit: 100 });

  if (waiting.isPending) return <LoadingBlock rows={3} />;
  if (waiting.isError) {
    return <ErrorAlert error={waiting.error} onRetry={() => void waiting.refetch()} />;
  }
  if (waiting.data.executions.length === 0) {
    return <EmptyState title="Nothing is waiting for approval." />;
  }
  return <ExecutionTable executions={waiting.data.executions} />;
}
