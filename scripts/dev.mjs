/* global process */
// Starts the backend and the UI together, sharing one fresh API token per run.
// The desktop app will generate its own token per launch; see docs/adr/0005.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const token = process.env.AAP_API_TOKEN ?? randomBytes(32).toString('base64url');
const env = { ...process.env, AAP_API_TOKEN: token, NEXT_PUBLIC_AAP_API_TOKEN: token };

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
