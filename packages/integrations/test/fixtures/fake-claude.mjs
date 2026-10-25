/* global process, setTimeout */
// Stands in for the `claude` CLI in tests. FAKE_CLAUDE_MODE picks the behaviour.
const mode = process.env.FAKE_CLAUDE_MODE ?? 'success';
const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', () => {
  const echo = {
    args,
    cwd: process.cwd(),
    stdin,
    sawToken: 'AAP_API_TOKEN' in process.env,
    sawNested: 'CLAUDECODE' in process.env,
  };
  const result = (fields) =>
    process.stdout.write(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 2,
        total_cost_usd: 0.01,
        session_id: 's1',
        ...fields,
      }),
    );

  switch (mode) {
    case 'success':
      result({ result: JSON.stringify(echo) });
      break;
    case 'rate-limited':
      result({
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: 429,
        result: 'Rate limit reached',
      });
      process.exitCode = 1;
      break;
    case 'garbage':
      process.stdout.write('not json at all');
      break;
    case 'slow':
      setTimeout(() => result({ result: 'late' }), 30_000);
      break;
    default:
      process.stderr.write(`unknown mode ${mode}`);
      process.exitCode = 2;
  }
});
