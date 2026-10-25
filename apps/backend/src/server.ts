import { buildApp } from './app.js';
import { ConfigError, loadConfig, type AppConfig } from './config/env.js';

function readConfig(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // The logger does not exist yet, so report straight to stderr.
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();
const app = await buildApp(config);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down');
  try {
    await app.close();
  } catch (error) {
    app.log.error({ err: error }, 'Graceful shutdown failed');
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown(signal));
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'Failed to start the backend');
  process.exit(1);
}
