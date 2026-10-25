/* global process, URL */
// Starts the backend and the UI together, sharing one fresh API token per run.
// The desktop app will generate its own token per launch; see docs/adr/0005.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const token = process.env.AAP_API_TOKEN ?? randomBytes(32).toString('base64url');
// Unless you choose your own, workflows may use the sample code in examples/ and nothing else.
const examples = fileURLToPath(new URL('../examples', import.meta.url));
const env = {
  ...process.env,
  AAP_API_TOKEN: token,
  NEXT_PUBLIC_AAP_API_TOKEN: token,
  AAP_WORKSPACE_ROOTS: process.env.AAP_WORKSPACE_ROOTS ?? examples,
};

// A fixed command with no outside input, so running it through the shell is safe. The shell
// is needed on Windows to find pnpm.cmd.
const child = spawn('pnpm --parallel --filter @aap/backend --filter @aap/desktop dev', {
  stdio: 'inherit',
  env,
  shell: true,
});

child.on('exit', (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
