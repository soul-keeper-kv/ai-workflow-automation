import { API_ERROR_CODES, type ApiErrorCode, type ApiErrorResponse } from '@aap/shared';
import type { FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

function errorBody(code: ApiErrorCode, message: string): ApiErrorResponse {
  return { error: { code, message } };
}

/**
 * Every error leaves the API in the shared envelope, with a stable code and no stack trace.
 * Called directly on the root instance (not registered as a plugin) so it is not encapsulated.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send(errorBody(API_ERROR_CODES.validationFailed, error.message));
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'Response did not match its schema');
      return reply
        .code(500)
        .send(errorBody(API_ERROR_CODES.internalError, 'An unexpected error occurred.'));
    }

    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;

    if (statusCode >= 400 && statusCode < 500) {
      const message = error instanceof Error ? error.message : 'Bad request.';
      return reply.code(statusCode).send(errorBody(API_ERROR_CODES.badRequest, message));
    }

    request.log.error({ err: error }, 'Unhandled error');
    return reply
      .code(500)
      .send(errorBody(API_ERROR_CODES.internalError, 'An unexpected error occurred.'));
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(errorBody(API_ERROR_CODES.notFound, 'Route not found.')),
  );
}
