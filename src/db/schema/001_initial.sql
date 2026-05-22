CREATE TABLE migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE runtime_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE processed_blocks (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL CHECK (chain_id = 137),
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REORGED','REPLACED')),
  log_count INTEGER NOT NULL DEFAULT 0 CHECK (log_count >= 0),
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  reorged_at TEXT,
  replacement_block_hash TEXT
);
CREATE UNIQUE INDEX ux_processed_blocks_active
  ON processed_blocks(chain_id, block_number)
  WHERE status = 'ACTIVE';
CREATE INDEX ix_processed_blocks_status_number
  ON processed_blocks(status, block_number);

CREATE TABLE block_cursor_history (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL CHECK (chain_id = 137),
  action TEXT NOT NULL CHECK (action IN ('ADVANCE','ROLLBACK')),
  from_block INTEGER NOT NULL,
  to_block INTEGER NOT NULL,
  safe_head_at_process INTEGER NOT NULL,
  cursor_before INTEGER NOT NULL,
  cursor_after INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (to_block >= from_block),
  CHECK (
    (action = 'ADVANCE' AND cursor_after >= to_block AND cursor_after >= cursor_before)
    OR
    (action = 'ROLLBACK' AND cursor_after < cursor_before)
  )
);

CREATE TABLE source_fills (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL CHECK (chain_id = 137),
  contract_address TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  tx_index INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('INGESTED','DECODED','NORMALIZED','GROUPED','DECIDED','SKIPPED','REORGED','ERROR')),
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
CREATE INDEX ix_source_fills_status_block
  ON source_fills(status, block_number);
CREATE INDEX ix_source_fills_tx
  ON source_fills(chain_id, contract_address, tx_hash, log_index);

CREATE TABLE aggregation_groups (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL CHECK (chain_id = 137),
  contract_address TEXT NOT NULL,
  source_wallet TEXT NOT NULL,
  token_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  window_start_block INTEGER NOT NULL,
  window_end_block INTEGER NOT NULL,
  reorg_generation INTEGER NOT NULL DEFAULT 0 CHECK (reorg_generation >= 0),
  predecessor_aggregation_group_id TEXT REFERENCES aggregation_groups(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('OPEN','READY','DECIDED','SKIPPED','REORGED','ERROR')),
  leader_price_ppm TEXT,
  leader_notional_raw TEXT,
  leader_budget_impact_raw TEXT,
  token_delta_raw TEXT,
  inventory_delta_raw TEXT,
  fee_raw TEXT NOT NULL DEFAULT '0',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_aggregation_groups_active_window
  ON aggregation_groups(chain_id, contract_address, source_wallet, token_id, side, window_start_block)
  WHERE status != 'REORGED';
CREATE INDEX ix_aggregation_groups_status_window
  ON aggregation_groups(status, window_end_block);

CREATE TABLE aggregation_group_source_fills (
  aggregation_group_id TEXT NOT NULL REFERENCES aggregation_groups(id) ON DELETE RESTRICT,
  source_fill_id TEXT NOT NULL REFERENCES source_fills(id) ON DELETE RESTRICT,
  PRIMARY KEY (aggregation_group_id, source_fill_id)
);

CREATE TABLE copy_decisions (
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
CREATE INDEX ix_copy_decisions_source_created
  ON copy_decisions(source_wallet, created_at);
CREATE INDEX ix_copy_decisions_status
  ON copy_decisions(status);

CREATE TABLE risk_reservations (
  id TEXT PRIMARY KEY,
  copy_decision_id TEXT NOT NULL REFERENCES copy_decisions(id) ON DELETE RESTRICT,
  token_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  p_usd_reserved_raw TEXT NOT NULL DEFAULT '0',
  p_usd_fee_reserved_raw TEXT NOT NULL DEFAULT '0',
  inventory_reserved_raw TEXT NOT NULL DEFAULT '0',
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','RELEASED','ADJUSTED','ORPHANED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  released_at TEXT
);
CREATE UNIQUE INDEX ux_risk_reservations_active
  ON risk_reservations(copy_decision_id)
  WHERE state = 'ACTIVE';

CREATE TABLE order_submissions (
  id TEXT PRIMARY KEY,
  copy_decision_id TEXT NOT NULL UNIQUE REFERENCES copy_decisions(id) ON DELETE RESTRICT,
  signed_order_hash TEXT NOT NULL UNIQUE,
  encrypted_signed_payload_json TEXT,
  current_state TEXT NOT NULL CHECK (current_state IN (
    'CREATED','SUBMITTING','SUBMITTED','ACK_FILLED','ACK_PARTIAL',
    'ACK_REJECTED','TIMEOUT_UNKNOWN','CANCELLED','FAILED'
  )),
  order_type TEXT NOT NULL CHECK (order_type IN ('FAK','FOK')),
  limit_price_ppm TEXT NOT NULL,
  intended_notional_raw TEXT NOT NULL,
  intended_size_raw TEXT NOT NULL,
  filled_size_raw TEXT NOT NULL DEFAULT '0',
  abandoned_size_raw TEXT NOT NULL DEFAULT '0',
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0),
  last_error TEXT,
  payload_erased_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (current_state IN ('CREATED','SUBMITTING','SUBMITTED','TIMEOUT_UNKNOWN') AND encrypted_signed_payload_json IS NOT NULL)
    OR
    (current_state IN ('ACK_FILLED','ACK_PARTIAL','ACK_REJECTED','CANCELLED','FAILED'))
  )
);
CREATE INDEX ix_order_submissions_state_updated
  ON order_submissions(current_state, updated_at);

CREATE TABLE order_attempts (
  id TEXT PRIMARY KEY,
  order_submission_id TEXT NOT NULL REFERENCES order_submissions(id) ON DELETE RESTRICT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  action TEXT NOT NULL,
  request_json_redacted TEXT,
  response_json_redacted TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_order_attempts_submission_created
  ON order_attempts(order_submission_id, created_at);

CREATE TABLE follower_fills (
  id TEXT PRIMARY KEY,
  order_submission_id TEXT NOT NULL REFERENCES order_submissions(id) ON DELETE RESTRICT,
  signed_order_hash TEXT NOT NULL,
  clob_fill_id TEXT,
  fill_hash TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  token_id TEXT NOT NULL,
  price_ppm TEXT NOT NULL,
  size_raw TEXT NOT NULL,
  p_usd_delta_raw TEXT NOT NULL,
  fee_raw TEXT NOT NULL DEFAULT '0',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(clob_fill_id),
  UNIQUE(signed_order_hash, fill_hash)
);

CREATE TABLE position_movements (
  id TEXT PRIMARY KEY,
  follower_fill_id TEXT REFERENCES follower_fills(id) ON DELETE RESTRICT,
  reconciliation_run_id TEXT REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('BUY_FILL','SELL_FILL','RECONCILE_ADJUSTMENT')),
  token_id TEXT NOT NULL,
  shares_delta_raw TEXT NOT NULL,
  p_usd_delta_raw TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (movement_type IN ('BUY_FILL','SELL_FILL') AND follower_fill_id IS NOT NULL AND reconciliation_run_id IS NULL)
    OR
    (movement_type = 'RECONCILE_ADJUSTMENT' AND follower_fill_id IS NULL AND reconciliation_run_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX ux_position_movements_fill
  ON position_movements(follower_fill_id, movement_type, token_id)
  WHERE follower_fill_id IS NOT NULL;
CREATE INDEX ix_position_movements_token_occurred
  ON position_movements(token_id, occurred_at);

CREATE TABLE positions (
  token_id TEXT PRIMARY KEY,
  shares_raw TEXT NOT NULL DEFAULT '0',
  expected_onchain_shares_raw TEXT NOT NULL DEFAULT '0',
  last_onchain_shares_raw TEXT NOT NULL DEFAULT '0',
  last_reconciled_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE reconciliation_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL CHECK (run_type IN ('STARTUP','POST_FILL','TIMEOUT_RECOVERY','PERIODIC','REORG')),
  status TEXT NOT NULL CHECK (status IN ('OK','DIVERGED','ERROR')),
  p_usd_balance_raw TEXT,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
