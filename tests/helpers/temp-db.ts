import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";

export interface TempDb {
  db: SqliteDatabase;
  path: string;
  cleanup(): Promise<void>;
}

export async function createTempDb(): Promise<TempDb> {
  const dir = await mkdtemp(join(tmpdir(), "polycopy-test-"));
  const path = join(dir, `polycopy-test-${randomUUID()}.db`);
  const db = openDatabase(path);

  return {
    db,
    path,
    async cleanup() {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

export async function createMigratedTempDb(): Promise<TempDb> {
  const tempDb = await createTempDb();
  runMigrations(tempDb.db);
  return tempDb;
}
