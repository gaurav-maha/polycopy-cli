PRAGMA foreign_keys = OFF;

CREATE TABLE copy_decisions_new (
  id TEXT PRIMARY KEY,
  aggregation_group_id TEXT NOT NULL UNIQUE REFERENCES aggregation_groups(id) ON DELETE RESTRICT,
  chain_id INTEGER NOT NULL CHECK (chain_id = 137),
  contract_address TEXT NOT NULL,
  source_wallet TEXT NOT NULL,
  token_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','SKIPPED','SKIPPED_REORG','POST_REORG_ORPHAN','ERROR')),
  leader_price_ppm TEXT NOT NULL,
  leader_notional_raw TEXT NOT NULL,
  leader_budget_impact_raw TEXT NOT NULL,
  intended_copy_notional_raw TEXT NOT NULL,
  approved_copy_notional_raw TEXT,
  risk_config_hash TEXT NOT NULL,
  gate_snapshot_json TEXT NOT NULL,
  skip_reason TEXT CHECK (skip_reason IN (
    'CONFIG_INVALID','KILL_SWITCH','STALE_LOG','STALE_BOOK','STALE_AT_SIGN',
    'BOOK_SOURCE_MISMATCH','SPREAD','DRIFT_BUY','DRIFT_SELL','PRICE_ABOVE_MAX_BUY','PRICE_BELOW_MIN_SELL','DEPTH_INSUFFICIENT',
    'PARTICIPATION','SUB_MIN','SIDE_DISABLED','NO_INVENTORY','MARKET_PAUSED','MARKET_RESOLVED',
    'MAKER_SIDE','ROLE_AMBIGUOUS','QUEUE_OVERFLOW','BUDGET','DAILY_CAP','REORG',
    'RPC_DISAGREEMENT','BOOK_GAP','CACHE_MISMATCH','ERROR'
  )),
  error_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO copy_decisions_new (
  id,
  aggregation_group_id,
  chain_id,
  contract_address,
  source_wallet,
  token_id,
  side,
  status,
  leader_price_ppm,
  leader_notional_raw,
  leader_budget_impact_raw,
  intended_copy_notional_raw,
  approved_copy_notional_raw,
  risk_config_hash,
  gate_snapshot_json,
  skip_reason,
  error_reason,
  created_at,
  updated_at
)
SELECT
  id,
  aggregation_group_id,
  chain_id,
  contract_address,
  source_wallet,
  token_id,
  side,
  status,
  leader_price_ppm,
  leader_notional_raw,
  leader_budget_impact_raw,
  intended_copy_notional_raw,
  approved_copy_notional_raw,
  risk_config_hash,
  gate_snapshot_json,
  skip_reason,
  error_reason,
  created_at,
  updated_at
FROM copy_decisions;

DROP TABLE copy_decisions;

ALTER TABLE copy_decisions_new RENAME TO copy_decisions;

CREATE INDEX ix_copy_decisions_source_created
  ON copy_decisions(source_wallet, created_at);
CREATE INDEX ix_copy_decisions_status
  ON copy_decisions(status);

PRAGMA foreign_keys = ON;
