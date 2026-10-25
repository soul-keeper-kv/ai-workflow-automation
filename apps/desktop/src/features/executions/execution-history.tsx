'use client';

import { EXECUTION_STATUSES, executionStatusSchema, type ExecutionStatus } from '@aap/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { EmptyState, ErrorAlert, LoadingBlock } from '@/components/query-states';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useExecutions, useWorkflows } from '@/hooks/use-api';
import { STATUS_LABELS } from '@/lib/execution-status';
import { ExecutionTable } from './execution-table';

const PAGE_SIZE = 25;
const ALL = 'all';

/** Filters live in the URL, so a filtered view survives reloads and can be linked. */
export function ExecutionHistory() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const workflowId = params.get('workflowId') ?? undefined;
  const statusParam = executionStatusSchema.safeParse(params.get('status'));
  const status: ExecutionStatus | undefined = statusParam.success ? statusParam.data : undefined;
  const page = Math.max(0, Number.parseInt(params.get('page') ?? '0', 10) || 0);

  const workflows = useWorkflows();
  const executions = useExecutions({
    workflowId,
    status,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === ALL) next.delete(key);
      else next.set(key, value);
    }
    if (!('page' in changes)) next.delete('page');
    const query = next.toString();
    router.replace(query === '' ? pathname : `${pathname}?${query}`);
  };

  const workflowItems = [
    { value: ALL, label: 'All workflows' },
    ...(workflows.data?.workflows ?? []).map((w) => ({ value: w.id, label: w.name })),
  ];
  const statusItems = [
    { value: ALL, label: 'All statuses' },
    ...EXECUTION_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
  ];
  const total = executions.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-workflow">Workflow</Label>
          <Select
            items={workflowItems}
            value={workflowId ?? ALL}
            onValueChange={(value) => update({ workflowId: value })}
          >
            <SelectTrigger id="filter-workflow" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {workflowItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-status">Status</Label>
          <Select
            items={statusItems}
            value={status ?? ALL}
            onValueChange={(value) => update({ status: value })}
          >
            <SelectTrigger id="filter-status" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {statusItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {executions.isPending ? (
        <LoadingBlock rows={5} />
      ) : executions.isError ? (
        <ErrorAlert error={executions.error} onRetry={() => void executions.refetch()} />
      ) : executions.data.executions.length === 0 ? (
        <EmptyState title="No executions match.">Start one from the Workflows page.</EmptyState>
      ) : (
        <>
          <ExecutionTable executions={executions.data.executions} />
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {total} execution{total === 1 ? '' : 's'} · page {page + 1} of {pages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => update({ page: String(page - 1) })}
              >
                <ChevronLeft aria-hidden />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 >= pages}
                onClick={() => update({ page: String(page + 1) })}
              >
                Next
                <ChevronRight aria-hidden />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
