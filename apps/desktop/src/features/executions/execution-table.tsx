'use client';

import type { ExecutionSummary } from '@aap/shared';
import Link from 'next/link';
import { StatusBadge } from '@/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useNow } from '@/hooks/use-now';
import { elapsedMs, formatDateTime, formatDuration, shortId } from '@/lib/format';

export function ExecutionTable({ executions }: { executions: readonly ExecutionSummary[] }) {
  const now = useNow(
    1_000,
    executions.some((e) => e.completedAt === null),
  );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Workflow</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Current step</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Id</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {executions.map((execution) => (
          <TableRow key={execution.id}>
            <TableCell className="font-medium">
              <Link
                href={`/executions/detail?id=${execution.id}`}
                className="underline-offset-4 hover:underline"
              >
                {execution.workflowName}
              </Link>
            </TableCell>
            <TableCell>
              <StatusBadge status={execution.status} />
            </TableCell>
            <TableCell>{execution.currentStateTitle}</TableCell>
            <TableCell>{formatDateTime(execution.startedAt ?? execution.createdAt)}</TableCell>
            <TableCell>
              {formatDuration(elapsedMs(execution.startedAt, execution.completedAt, now))}
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">
              {shortId(execution.id)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
