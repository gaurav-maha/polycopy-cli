PRAGMA foreign_keys = OFF;

CREATE TABLE source_fills_new (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL CHECK (chain_id = 137),
  contract_address TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  tx_index INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','INGESTED','DECODED','NORMALIZED','GROUPED','DECIDED','SKIPPED','REORGED','ERROR')),
  raw_log_json TEXT NOT NULL,
  decoded_json TEXT,
  source_wallet TEXT,
  side TEXT CHECK (side IN ('BUY','SELL')),
  token_id TEXT,
  maker_amount_filled_raw TEXT,
  taker_amount_filled_raw TEXT,
  fee_raw TEXT NOT NULL DEFAULT '0',
  price_ppm TEXT,
  skip_reason TEXT,
  error_reason TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chain_id, contract_address, block_hash, tx_hash, log_index)
);

INSERT INTO source_fills_new SELECT * FROM source_fills;

DROP TABLE source_fills;

ALTER TABLE source_fills_new RENAME TO source_fills;

CREATE INDEX ix_source_fills_status_block
  ON source_fills(status, block_number);
CREATE INDEX ix_source_fills_tx
  ON source_fills(chain_id, contract_address, tx_hash, log_index);

PRAGMA foreign_keys = ON;
