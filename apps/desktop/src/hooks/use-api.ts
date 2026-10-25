'use client';

import type { ListExecutionsQuery } from '@aap/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { isLive } from '@/lib/execution-status';

/** Polling interval while an execution is still moving. SSE can replace this later. */
const LIVE_POLL_MS = 1_000;
const LIST_POLL_MS = 3_000;

export const queryKeys = {
  health: ['health'] as const,
  workflows: ['workflows'] as const,
  workflow: (id: string) => ['workflows', id] as const,
  executions: (query: ListExecutionsQuery) => ['executions', 'list', query] as const,
  stats: ['executions', 'stats'] as const,
  execution: (id: string) => ['executions', 'detail', id] as const,
  events: (id: string) => ['executions', 'events', id] as const,
};

export function useWorkflows() {
  return useQuery({
    queryKey: queryKeys.workflows,
    queryFn: ({ signal }) => api.listWorkflows(signal),
  });
}

export function useWorkflow(id: string | null) {
  return useQuery({
    queryKey: queryKeys.workflow(id ?? ''),
    queryFn: ({ signal }) => api.getWorkflow(id ?? '', signal),
    enabled: id !== null,
  });
}

export function useExecutions(query: ListExecutionsQuery) {
  return useQuery({
    queryKey: queryKeys.executions(query),
    queryFn: ({ signal }) => api.listExecutions(query, signal),
    refetchInterval: LIST_POLL_MS,
    placeholderData: (previous) => previous,
  });
}

export function useExecutionStats() {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: ({ signal }) => api.executionStats(signal),
    refetchInterval: LIST_POLL_MS,
  });
}

export function useExecution(id: string | null) {
  return useQuery({
    queryKey: queryKeys.execution(id ?? ''),
    queryFn: ({ signal }) => api.getExecution(id ?? '', signal),
    enabled: id !== null,
    refetchInterval: (query) => {
      const execution = query.state.data?.execution;
      return execution !== undefined && isLive(execution.status) ? LIVE_POLL_MS : false;
    },
  });
}

/**
 * Events of one execution. `version` (the execution's updatedAt) is part of the key, so the
 * list refetches whenever the execution changes, including the last change before it stops
 * being live.
 */
export function useExecutionEvents(id: string | null, live: boolean, version: string) {
  return useQuery({
    queryKey: [...queryKeys.events(id ?? ''), version],
    queryFn: ({ signal }) => api.listEvents(id ?? '', signal),
    enabled: id !== null,
    refetchInterval: live ? LIVE_POLL_MS : false,
    placeholderData: (previous) => previous,
  });
}

export function useStartExecution() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ workflowId, input }: { workflowId: string; input: unknown }) =>
      api.startExecution(workflowId, input),
    onSuccess: () => client.invalidateQueries({ queryKey: ['executions'] }),
  });
}

export function useCancelExecution() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (executionId: string) => api.cancelExecution(executionId),
    onSuccess: (result) => {
      client.setQueryData(queryKeys.execution(result.execution.id), {
        execution: result.execution,
      });
      return client.invalidateQueries({ queryKey: ['executions'] });
    },
  });
}

export function useDecideApproval() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      executionId: string;
      approvalId: string;
      decision: 'APPROVED' | 'REJECTED';
      feedback: string;
    }) => api.decideApproval(args.executionId, args.approvalId, args.decision, args.feedback),
    onSuccess: ({ execution }) => {
      client.setQueryData(queryKeys.execution(execution.id), { execution });
      return client.invalidateQueries({ queryKey: ['executions'] });
    },
  });
}

export function useResumeExecution() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (executionId: string) => api.resumeExecution(executionId),
    onSuccess: ({ execution }) => {
      client.setQueryData(queryKeys.execution(execution.id), { execution });
      return client.invalidateQueries({ queryKey: ['executions'] });
    },
  });
}
