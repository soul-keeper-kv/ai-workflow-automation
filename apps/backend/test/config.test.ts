import { DEFAULT_BACKEND_PORT } from '@aap/shared';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig as load } from '../src/config/env.js';

const TOKEN = 't'.repeat(32);
const loadConfig = (env: Record<string, string>) => load({ AAP_API_TOKEN: TOKEN, ...env });

describe('loadConfig', () => {
  it('defaults to loopback and the shared default port', () => {
    const config = loadConfig({});

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(DEFAULT_BACKEND_PORT);
    expect(config.allowedOrigins).toContain('http://tauri.localhost');
  });

  it.each(['0.0.0.0', '::', '192.168.1.10', 'localhost'])(
    'rejects non-loopback host %s',
    (host) => {
      expect(() => loadConfig({ AAP_HOST: host })).toThrow(ConfigError);
    },
  );

  it('requires an API token of at least 32 characters', () => {
    expect(() => load({})).toThrow(/AAP_API_TOKEN/);
    expect(() => load({ AAP_API_TOKEN: 'short' })).toThrow(ConfigError);
    expect(loadConfig({}).apiToken).toBe(TOKEN);
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ AAP_PORT: '70000' })).toThrow(ConfigError);
  });

  it('parses a comma-separated origin list', () => {
    const config = loadConfig({
      AAP_ALLOWED_ORIGINS: ' http://localhost:3001 , tauri://localhost ',
    });

    expect(config.allowedOrigins).toEqual(['http://localhost:3001', 'tauri://localhost']);
  });

  it('rejects an origin that contains a path', () => {
    expect(() => loadConfig({ AAP_ALLOWED_ORIGINS: 'http://localhost:3000/app' })).toThrow(
      ConfigError,
    );
  });
});
