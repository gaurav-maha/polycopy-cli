import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

export function openDatabase(path: string): SqliteDatabase {
  const db = new Database(path);
  configureDatabase(db);
  return db;
}

export function configureDatabase(db: SqliteDatabase): void {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 5000");
}
