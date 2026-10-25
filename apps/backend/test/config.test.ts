import { DEFAULT_BACKEND_PORT } from '@aap/shared';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/env.js';

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
