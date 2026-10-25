import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { API_URL, BACKEND_ENTRY, E2E_TOKEN, REPO_ROOT } from './support/constants.js';

/**
 * Builds the UI with the end-to-end API URL and token inlined. Run `pnpm build` before, so
 * the backend's dist/ exists; `pnpm e2e` at the repository root does both.
 */
export default function globalSetup(): void {
  if (!existsSync(BACKEND_ENTRY)) {
    throw new Error(`${BACKEND_ENTRY} is missing. Run "pnpm build" first (or "pnpm e2e").`);
  }
  execSync('pnpm --filter @aap/desktop build', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, NEXT_PUBLIC_AAP_API_URL: API_URL, NEXT_PUBLIC_AAP_API_TOKEN: E2E_TOKEN },
  });
}
