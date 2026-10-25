import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../src/config/env.js';

export const TEST_TOKEN = 'test-token-0123456789-0123456789-abcdef';
export const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

/** A config with logging off and a fresh data directory, removed by `cleanup`. */
export function testConfig(env: Record<string, string> = {}): AppConfig & { cleanup(): void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'aap-backend-'));
  return {
    ...loadConfig({
      AAP_LOG_LEVEL: 'silent',
      AAP_DATA_DIR: dataDir,
      AAP_API_TOKEN: TEST_TOKEN,
      ...env,
    }),
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}
