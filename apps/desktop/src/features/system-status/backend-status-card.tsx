'use client';

import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, LoaderCircle, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getHealth } from '@/lib/api-client';
import { apiBaseUrl } from '@/lib/config';

const POLL_INTERVAL_MS = 10_000;

function formatUptime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function BackendStatusCard() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => getHealth(signal),
    refetchInterval: POLL_INTERVAL_MS,
  });

  return (
    <Card data-testid="backend-status">
      <CardHeader>
        <CardTitle>Local backend</CardTitle>
        <CardDescription className="font-mono text-xs">{apiBaseUrl}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2" aria-live="polite">
          {health.isPending ? (
            <Badge variant="secondary">
              <LoaderCircle className="animate-spin" aria-hidden />
              Checking
            </Badge>
          ) : health.isError ? (
            <Badge variant="destructive">
              <CircleX aria-hidden />
              Unavailable
            </Badge>
          ) : (
            <Badge>
              <CircleCheck aria-hidden />
              Connected
            </Badge>
          )}
          {health.isFetching && !health.isPending ? (
            <span className="text-xs text-muted-foreground">Refreshing…</span>
          ) : null}
        </div>

        {health.isSuccess ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Version</dt>
            <dd className="font-mono">{health.data.version}</dd>
            <dt className="text-muted-foreground">Uptime</dt>
            <dd className="font-mono">{formatUptime(health.data.uptimeSeconds)}</dd>
          </dl>
        ) : null}

        {health.isError ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">{health.error.message}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void health.refetch()}
              disabled={health.isFetching}
            >
              <RefreshCw aria-hidden />
              Retry
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
