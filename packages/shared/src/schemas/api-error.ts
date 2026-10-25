import { z } from 'zod';

/** Stable error codes returned by the backend. Clients branch on these, never on messages. */
export const API_ERROR_CODES = {
  badRequest: 'BAD_REQUEST',
  validationFailed: 'VALIDATION_FAILED',
  notFound: 'NOT_FOUND',
  internalError: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

/**
 * Envelope for every non-2xx response.
 * `code` is a plain string so an older client still parses codes added later.
 */
export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
