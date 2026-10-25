import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { schema } from './schema.js';

/** `drizzle/` at the package root. Resolves from both src/ and dist/, one level deeper each. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export type WorkflowDb = BetterSQLite3Database<typeof schema>;

export interface WorkflowDatabase {
  readonly db: WorkflowDb;
  readonly sqlite: Database.Database;
  close(): void;
}

/**
 * Opens (or creates) the SQLite file and applies pending migrations.
 * Migrations run inside a transaction; a failed migration leaves the schema as it was.
 */
export function openWorkflowDatabase(filePath: string): WorkflowDatabase {
  const sqlite = new Database(filePath);
  try {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');

    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    return {
      db,
      sqlite,
      close: () => {
        if (sqlite.open) sqlite.close();
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
