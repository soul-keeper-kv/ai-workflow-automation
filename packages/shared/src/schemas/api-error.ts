import { z } from 'zod';

/** Stable error codes returned by the backend. Clients branch on these, never on messages. */
export const API_ERROR_CODES = {
  badRequest: 'BAD_REQUEST',
  validationFailed: 'VALIDATION_FAILED',
  unauthorized: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  notFound: 'NOT_FOUND',
  /** The request is valid but conflicts with the current state, e.g. cancelling a finished run. */
  conflict: 'CONFLICT',
  payloadTooLarge: 'PAYLOAD_TOO_LARGE',
  internalError: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

export const validationIssueSchema = z.object({
  /** Dot-separated path into the validated value; empty for the value itself. */
  path: z.string(),
  message: z.string(),
});

export type ValidationIssueDto = z.infer<typeof validationIssueSchema>;

/**
 * Envelope for every non-2xx response.
 * `code` is a plain string so an older client still parses codes added later.
 */
export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Present for VALIDATION_FAILED. */
    issues: z.array(validationIssueSchema).optional(),
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
