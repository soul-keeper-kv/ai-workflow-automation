import {
  API_ERROR_CODES,
  type ApiErrorCode,
  type ApiErrorResponse,
  type ValidationIssueDto,
} from '@aap/shared';
import {
  ConcurrentModificationError,
  ExecutionConflictError,
  ExecutionNotFoundError,
  InputValidationError,
  InvalidStatusTransitionError,
  PayloadTooLargeError,
  WorkflowEngineError,
  WorkflowNotFoundError,
} from '@aap/workflow-core';
import type { FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

function errorBody(
  code: ApiErrorCode,
  message: string,
  issues?: ValidationIssueDto[],
): ApiErrorResponse {
  return { error: { code, message, ...(issues === undefined ? {} : { issues }) } };
}

const UNEXPECTED = 'An unexpected error occurred.';

/**
 * Every error leaves the API in the shared envelope, with a stable code and no stack trace.
 * Domain errors from the workflow core map to HTTP here, so route handlers stay thin.
 * Called directly on the root instance (not registered as a plugin) so it is not encapsulated.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues = error.validation.map((issue) => ({
        path: [error.validationContext, ...issue.instancePath.split('/').filter(Boolean)]
          .filter(Boolean)
          .join('.'),
        message: issue.message ?? 'Invalid value.',
      }));
      return reply
        .code(400)
        .send(errorBody(API_ERROR_CODES.validationFailed, 'The request is invalid.', issues));
    }
    if (error instanceof InputValidationError) {
      return reply
        .code(400)
        .send(
          errorBody(API_ERROR_CODES.validationFailed, 'The workflow input is invalid.', [
            ...error.issues,
          ]),
        );
    }
    if (error instanceof WorkflowNotFoundError || error instanceof ExecutionNotFoundError) {
      return reply.code(404).send(errorBody(API_ERROR_CODES.notFound, error.message));
    }
    if (
      error instanceof ExecutionConflictError ||
      error instanceof InvalidStatusTransitionError ||
      error instanceof ConcurrentModificationError
    ) {
      return reply.code(409).send(errorBody(API_ERROR_CODES.conflict, error.message));
    }
    if (error instanceof WorkflowEngineError && error.code === 'ENGINE_STOPPING') {
      return reply.code(409).send(errorBody(API_ERROR_CODES.conflict, error.message));
    }
    if (error instanceof PayloadTooLargeError) {
      return reply.code(413).send(errorBody(API_ERROR_CODES.payloadTooLarge, error.message));
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'Response did not match its schema');
      return reply.code(500).send(errorBody(API_ERROR_CODES.internalError, UNEXPECTED));
    }

    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;

    if (statusCode >= 400 && statusCode < 500) {
      const message = error instanceof Error ? error.message : 'Bad request.';
      const code =
        statusCode === 413 ? API_ERROR_CODES.payloadTooLarge : API_ERROR_CODES.badRequest;
      return reply.code(statusCode).send(errorBody(code, message));
    }

    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send(errorBody(API_ERROR_CODES.internalError, UNEXPECTED));
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(errorBody(API_ERROR_CODES.notFound, 'Route not found.')),
  );
}
