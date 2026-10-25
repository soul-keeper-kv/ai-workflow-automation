'use client';

import type { ExecutionStatus } from '@aap/shared';
import { Play } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/app-shell';
import { EmptyState, ErrorAlert, LoadingBlock } from '@/components/query-states';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ExecutionTable } from '@/features/executions/execution-table';
import { BackendStatusCard } from '@/features/system-status/backend-status-card';
import { useExecutionStats } from '@/hooks/use-api';

const TILES: { label: string; status: ExecutionStatus | null }[] = [
  { label: 'Total executions', status: null },
  { label: 'Running', status: 'RUNNING' },
  { label: 'Awaiting approval', status: 'WAITING_FOR_APPROVAL' },
  { label: 'Failed', status: 'FAILED' },
];

export function Dashboard() {
  const stats = useExecutionStats();

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Executions on this machine."
        actions={
          <Link href="/workflows" className={buttonVariants({ size: 'sm' })}>
            <Play aria-hidden />
            Start a workflow
          </Link>
        }
      />
      <div className="flex flex-col gap-6">
        {stats.isPending ? (
          <LoadingBlock rows={2} />
        ) : stats.isError ? (
          <ErrorAlert error={stats.error} onRetry={() => void stats.refetch()} />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {TILES.map((tile) => {
                const value =
                  tile.status === null ? stats.data.total : stats.data.byStatus[tile.status];
                const href =
                  tile.status === null
                    ? '/executions'
                    : tile.status === 'WAITING_FOR_APPROVAL'
                      ? '/approvals'
                      : `/executions?status=${tile.status}`;
                return (
                  <Link key={tile.label} href={href} className="rounded-xl focus-visible:outline-2">
                    <Card className="h-full transition-colors hover:bg-muted/40">
                      <CardHeader>
                        <CardTitle className="text-sm font-normal text-muted-foreground">
                          {tile.label}
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <span
                          className="text-3xl font-semibold tabular-nums"
                          data-testid={`stat-${tile.status ?? 'total'}`}
                        >
                          {value}
                        </span>
                      </CardContent>
                    </Card>
                  </Link>
                );
              })}
            </div>
            <Card>
              <CardHeader>
                <CardTitle>Recently finished</CardTitle>
              </CardHeader>
              <CardContent>
                {stats.data.recentlyFinished.length === 0 ? (
                  <EmptyState title="Nothing has finished yet." />
                ) : (
                  <ExecutionTable executions={stats.data.recentlyFinished} />
                )}
              </CardContent>
            </Card>
          </>
        )}
        <BackendStatusCard />
      </div>
    </>
  );
}
