import type { SqliteDatabase } from "../db/client.js";

export function safeHead(latest: bigint, confirmationDepth: number): bigint {
  const depth = BigInt(Math.max(0, confirmationDepth));
  return latest > depth ? latest - depth : 0n;
}

export function readLastProcessedBlock(db: SqliteDatabase): bigint | null {
  const row = db.prepare("SELECT value FROM runtime_state WHERE key = 'last_processed_block'").get() as
    | { value: string }
    | undefined;
  if (!row?.value) return null;
  return BigInt(row.value);
}

export function writeLastProcessedBlock(db: SqliteDatabase, block: bigint): void {
  db.prepare("INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES ('last_processed_block', ?, datetime('now'))").run(
    block.toString()
  );
}
