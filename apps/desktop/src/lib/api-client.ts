import {
  apiErrorResponseSchema,
  cancelExecutionResponseSchema,
  executionResponseSchema,
  executionStatsResponseSchema,
  healthResponseSchema,
  listEventsResponseSchema,
  listExecutionsResponseSchema,
  listWorkflowsResponseSchema,
  workflowResponseSchema,
  type ListExecutionsQuery,
  type ValidationIssueDto,
} from '@aap/shared';
import type { z } from 'zod';
import { apiBaseUrl, apiToken } from './config';

const REQUEST_TIMEOUT_MS = 10_000;

/** Codes produced by the client itself, in addition to the backend's API_ERROR_CODES. */
export const CLIENT_ERROR_CODES = {
  backendUnreachable: 'BACKEND_UNREACHABLE',
  unexpectedResponse: 'UNEXPECTED_RESPONSE',
} as const;

export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    message: string,
    readonly code: string,
    /** HTTP status, or 0 when no response was received. */
    readonly status: number,
    readonly issues: readonly ValidationIssueDto[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal | undefined;
}

async function request<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}) {
  const url = new URL(path, apiBaseUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiToken !== null) headers.Authorization = `Bearer ${apiToken}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? null : JSON.stringify(options.body),
      signal,
    });
  } catch (cause) {
    throw new ApiError(
      `Cannot reach the local backend at ${apiBaseUrl}.`,
      CLIENT_ERROR_CODES.backendUnreachable,
      0,
      [],
      { cause },
    );
  }

  // Everything below is untrusted until a schema accepts it.
  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const error = apiErrorResponseSchema.safeParse(body);
    if (!error.success) {
      throw new ApiError(
        `The backend returned HTTP ${response.status}.`,
        CLIENT_ERROR_CODES.unexpectedResponse,
        response.status,
      );
    }
    const message =
      error.data.error.code === 'UNAUTHORIZED'
        ? 'The UI has no valid API token. Start the app with `pnpm dev`.'
        : error.data.error.message;
    throw new ApiError(message, error.data.error.code, response.status, error.data.error.issues);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      'The backend returned a response this app does not understand.',
      CLIENT_ERROR_CODES.unexpectedResponse,
      response.status,
      [],
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export const api = {
  health: (signal?: AbortSignal) => request('/health', healthResponseSchema, { signal }),

  listWorkflows: (signal?: AbortSignal) =>
    request('/api/workflows', listWorkflowsResponseSchema, { signal }),

  getWorkflow: (workflowId: string, signal?: AbortSignal) =>
    request(`/api/workflows/${encodeURIComponent(workflowId)}`, workflowResponseSchema, {
      signal,
    }),

  startExecution: (workflowId: string, input: unknown) =>
    request('/api/executions', executionResponseSchema, {
      method: 'POST',
      body: { workflowId, input },
    }),

  listExecutions: (query: ListExecutionsQuery, signal?: AbortSignal) =>
    request('/api/executions', listExecutionsResponseSchema, {
      signal,
      query: {
        workflowId: query.workflowId,
        status: query.status,
        limit: query.limit,
        offset: query.offset,
      },
    }),

  executionStats: (signal?: AbortSignal) =>
    request('/api/executions/stats', executionStatsResponseSchema, { signal }),

  getExecution: (executionId: string, signal?: AbortSignal) =>
    request(`/api/executions/${encodeURIComponent(executionId)}`, executionResponseSchema, {
      signal,
    }),

  listEvents: (executionId: string, signal?: AbortSignal) =>
    request(`/api/executions/${encodeURIComponent(executionId)}/events`, listEventsResponseSchema, {
      signal,
      query: { limit: 500 },
    }),

  decideApproval: (
    executionId: string,
    approvalId: string,
    decision: 'APPROVED' | 'REJECTED',
    feedback: string,
  ) =>
    request(
      `/api/executions/${encodeURIComponent(executionId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
      executionResponseSchema,
      {
        method: 'POST',
        body: feedback.trim() === '' ? { decision } : { decision, feedback },
      },
    ),

  resumeExecution: (executionId: string) =>
    request(`/api/executions/${encodeURIComponent(executionId)}/resume`, executionResponseSchema, {
      method: 'POST',
    }),

  cancelExecution: (executionId: string) =>
    request(
      `/api/executions/${encodeURIComponent(executionId)}/cancel`,
      cancelExecutionResponseSchema,
      { method: 'POST' },
    ),
};
