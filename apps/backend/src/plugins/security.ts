import { createHash, timingSafeEqual } from 'node:crypto';
import { API_ERROR_CODES, type ApiErrorResponse } from '@aap/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env.js';

/** Routes that work without the token. Keep this list short and free of data. */
const PUBLIC_ROUTES = new Set(['/health']);

/** Host names a legitimate local client uses. Anything else is a DNS-rebinding attempt. */
const LOOPBACK_HOST_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostName(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined) return undefined;
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0];
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token !== undefined ? token : undefined;
}

function deny(code: string, message: string): ApiErrorResponse {
  return { error: { code, message } };
}

/**
 * Local requests are not trusted by default (blueprint §15.1). Every request must name a
 * loopback Host and must not come from a page outside the allowlist; everything except
 * PUBLIC_ROUTES also needs the bearer token. CORS (registered separately) only controls what
 * browsers may read.
 */
export function registerSecurity(app: FastifyInstance, config: AppConfig): void {
  const expected = digest(config.apiToken);
  const allowedOrigins = new Set(config.allowedOrigins);

  app.addHook('onRequest', (request, reply, done) => {
    const host = hostName(request.headers.host);
    if (host === undefined || !LOOPBACK_HOST_NAMES.has(host)) {
      void reply.code(403).send(deny(API_ERROR_CODES.forbidden, 'Unexpected Host header.'));
      return;
    }

    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      void reply.code(403).send(deny(API_ERROR_CODES.forbidden, 'Origin not allowed.'));
      return;
    }

    // Decided by the matched route, not the raw URL, so encoded paths cannot slip past.
    // Unknown routes need the token too, so a 404 never reveals anything to a stranger.
    // Preflight requests never carry credentials; CORS answers them.
    const route = request.routeOptions.url;
    const needsToken =
      request.method !== 'OPTIONS' && (route === undefined || !PUBLIC_ROUTES.has(route));
    if (needsToken) {
      const token = bearerToken(request);
      if (token === undefined || !timingSafeEqual(digest(token), expected)) {
        void reply
          .code(401)
          .send(deny(API_ERROR_CODES.unauthorized, 'Missing or invalid API token.'));
        return;
      }
    }
    done();
  });
}
