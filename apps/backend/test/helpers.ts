import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../src/config/env.js';

/** A config with logging off and a fresh data directory, removed by `cleanup`. */
export function testConfig(env: Record<string, string> = {}): AppConfig & { cleanup(): void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'aap-backend-'));
  return {
    ...loadConfig({ AAP_LOG_LEVEL: 'silent', AAP_DATA_DIR: dataDir, ...env }),
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}
