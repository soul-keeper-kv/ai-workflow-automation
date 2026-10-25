import { apiErrorResponseSchema, healthResponseSchema } from '@aap/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { APP_VERSION } from '../src/version.js';

const config = loadConfig({ AAP_LOG_LEVEL: 'silent' });

let app: App;

beforeEach(async () => {
  app = await buildApp(config);
});

afterEach(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('returns the health contract with the package version', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = healthResponseSchema.parse(response.json());
    expect(body.status).toBe('ok');
    expect(body.version).toBe(APP_VERSION);
  });
});

describe('error envelope', () => {
  it('returns NOT_FOUND for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('hides internal error details from the client', async () => {
    app.get('/boom', () => {
      throw new Error('secret internal detail');
    });

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    const body = apiErrorResponseSchema.parse(response.json());
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('secret internal detail');
  });
});

describe('CORS', () => {
  it('allows the configured desktop origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://tauri.localhost' },
    });

    expect(response.headers['access-control-allow-origin']).toBe('http://tauri.localhost');
  });

  it('does not grant other origins access to responses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://evil.example' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
