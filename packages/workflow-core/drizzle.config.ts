import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @aap/workflow-core db:generate` writes a new migration after a schema change.
// Never edit a migration that has been committed; add a new one.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/persistence/schema.ts',
  out: './drizzle',
});
