import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SqliteExecutionStore, openWorkflowDatabase } from '../src/index.js';
import { tempDatabasePath } from './helpers.js';

const MIGRATIONS = new URL('../drizzle/', import.meta.url);
const journalSchema = z.object({ entries: z.array(z.object({ tag: z.string() }).loose()) }).loose();

let db: ReturnType<typeof tempDatabasePath>;
afterEach(() => db.cleanup());

/** A copy of the migrations folder that contains only the first `count` migrations. */
function migrationsUpTo(count: number, dir: string): string {
  const folder = join(dir, `migrations-${count}`);
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const journal = journalSchema.parse(
    JSON.parse(readFileSync(new URL('meta/_journal.json', MIGRATIONS), 'utf8')),
  );
  const entries = journal.entries.slice(0, count);
  for (const entry of entries) {
    cpSync(new URL(`${entry.tag}.sql`, MIGRATIONS), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  return folder;
}

describe('migrations', () => {
  it('upgrade a database that has data without losing any of it', () => {
    db = tempDatabasePath();
    const dir = join(db.path, '..');

    const old = new Database(db.path);
    try {
      old.pragma('foreign_keys = ON');
      migrate(drizzle(old), { migrationsFolder: migrationsUpTo(1, dir) });
      const oldStore = new SqliteExecutionStore(drizzle(old));
      oldStore.createExecution({
        id: 'e1',
        workflowId: 'w',
        workflowVersion: '1.0.0',
        currentState: 'FIRST',
        input: { a: 1 },
        context: { b: 2 },
      });
      oldStore.applyChange({
        executionId: 'e1',
        expectedRevision: 0,
        execution: { status: 'RUNNING' },
      });
    } finally {
      old.close();
    }

    const upgraded = openWorkflowDatabase(db.path);
    try {
      const store = new SqliteExecutionStore(upgraded.db);
      expect(store.getExecution('e1')).toMatchObject({ status: 'RUNNING', context: { b: 2 } });
      expect(store.listEvents('e1').map((e) => e.type)).toEqual([
        'EXECUTION_CREATED',
        'STATUS_CHANGED',
      ]);
      // The new event type is accepted after the upgrade.
      store.applyChange({
        executionId: 'e1',
        expectedRevision: 1,
        events: [{ type: 'CANCEL_REQUESTED' }],
      });
      expect(upgraded.sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(upgraded.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      upgraded.close();
    }
  });
});
