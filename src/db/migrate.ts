import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqliteDatabase } from "./client.js";

export interface MigrationRecord {
  version: number;
  name: string;
}

interface Migration extends MigrationRecord {
  sql: string;
}

const migrationFilePattern = /^(\d{3})_.+\.sql$/;

export function runMigrations(db: SqliteDatabase): void {
  for (const migration of loadMigrations()) {
    if (isMigrationApplied(db, migration.version)) {
      continue;
    }

    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO migrations (version, name) VALUES (?, ?)").run(migration.version, migration.name);
    })();
  }
}

function loadMigrations(): Migration[] {
  const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "schema");

  return readdirSync(schemaDir)
    .filter((name) => migrationFilePattern.test(name))
    .sort()
    .map((name) => {
      const match = migrationFilePattern.exec(name);
      if (!match) {
        throw new Error(`Invalid migration filename: ${name}`);
      }

      return {
        version: Number.parseInt(match[1], 10),
        name,
        sql: readFileSync(join(schemaDir, name), "utf8")
      };
    });
}

function isMigrationApplied(db: SqliteDatabase, version: number): boolean {
  if (!hasMigrationsTable(db)) {
    return false;
  }

  const row = db.prepare("SELECT 1 FROM migrations WHERE version = ?").get(version);
  return row !== undefined;
}

function hasMigrationsTable(db: SqliteDatabase): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migrations'")
    .get();
  return row !== undefined;
}
