import { openDatabase } from "../db/client.js";

export function listRows(dbPath: string, sql: string): unknown[] {
  const db = openDatabase(dbPath);
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}
