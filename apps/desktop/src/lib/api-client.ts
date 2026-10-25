import { apiErrorResponseSchema, healthResponseSchema, type HealthResponse } from '@aap/shared';
import type { z } from 'zod';
import { apiBaseUrl } from './config';

const REQUEST_TIMEOUT_MS = 5_000;

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
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

async function requestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  init: { signal?: AbortSignal | undefined } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(new URL(path, apiBaseUrl), {
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (cause) {
    throw new ApiError(
      `Cannot reach the local backend at ${apiBaseUrl}.`,
      CLIENT_ERROR_CODES.backendUnreachable,
      0,
      { cause },
    );
  }

  // Everything below is untrusted until a schema accepts it.
  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const error = apiErrorResponseSchema.safeParse(body);
    throw error.success
      ? new ApiError(error.data.error.message, error.data.error.code, response.status)
      : new ApiError(
          `The backend returned HTTP ${response.status}.`,
          CLIENT_ERROR_CODES.unexpectedResponse,
          response.status,
        );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      'The backend returned a response this app does not understand.',
      CLIENT_ERROR_CODES.unexpectedResponse,
      response.status,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return requestJson('/health', healthResponseSchema, { signal });
}
