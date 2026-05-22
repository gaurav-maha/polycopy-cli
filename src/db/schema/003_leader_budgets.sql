CREATE TABLE leader_budgets (
  id TEXT PRIMARY KEY,
  source_wallet TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  realized_spend_pusd_raw TEXT NOT NULL DEFAULT '0',
  reserved_spend_pusd_raw TEXT NOT NULL DEFAULT '0',
  trade_count INTEGER NOT NULL DEFAULT 0 CHECK (trade_count >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_wallet, day_utc)
);
CREATE INDEX ix_leader_budgets_wallet_day ON leader_budgets(source_wallet, day_utc);

ALTER TABLE risk_reservations ADD COLUMN source_wallet TEXT;
CREATE INDEX ix_risk_reservations_source_wallet
  ON risk_reservations(source_wallet)
  WHERE source_wallet IS NOT NULL;
