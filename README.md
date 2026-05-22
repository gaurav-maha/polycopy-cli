# polycopy-cli

Local CLI for copying Polymarket leader trades on Polygon.

## The Command

```bash
polycopy copytrade 0xLEADER [options]
```

Replace `0xLEADER` with the leader wallet address you want to copy.

`copytrade` has two modes:

| Mode | Command | Submits orders? | Needs wallet secrets? |
|------|---------|-----------------|-----------------------|
| Dry run | `polycopy copytrade 0xLEADER --dry-run --duration-minutes 5` | No | No |
| Live | `polycopy copytrade 0xLEADER --secrets .env --duration-minutes 1` | Yes | Yes |

Live is the default. If you do not pass `--dry-run`, the CLI loads `.env`, asks you to type `LIVE`, then runs the live ingest, risk, sign, submit, and recovery loop.

## 1. Install

```bash
git clone https://github.com/gaurav-maha/polycopy-cli.git
cd polycopy-cli
nvm use
npm ci
npm run build
npm link
polycopy --help
```

This repo expects Node.js `22.x`.

## 2. Add Polygon RPC

Add at least one real Polygon HTTP RPC URL:

```bash
polycopy rpc add "https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY"
polycopy rpc list
```

For live trading, add a second RPC as fallback:

```bash
polycopy rpc add "https://your-fallback-polygon-rpc.example"
```

Live mode requires a fallback RPC unless CI test bypass is active.

RPC commands:

```bash
polycopy rpc add <url>
polycopy rpc list
polycopy rpc show
polycopy rpc remove <url>
polycopy rpc path
```

There is no `rpc set`; use `add` and `remove` so the primary/fallback list stays explicit. The first URL is primary. Additional URLs are fallbacks.

## 3. Dry Run

Dry run only needs RPC and a leader address:

```bash
polycopy copytrade 0xLEADER --dry-run --duration-minutes 5
```

If your RPC provider does not support WebSocket logs, use HTTP polling:

```bash
polycopy copytrade 0xLEADER --dry-run --http-fallback --duration-minutes 5
```

## 4. Prepare Live Wallet Secrets

Create or import a dedicated low-balance owner wallet:

```bash
polycopy wallet new --wallet-file ~/.config/polycopy/wallet.env
# or:
polycopy wallet import --wallet-file ~/.config/polycopy/wallet.env --private-key-file ./owner-key.txt
```

The wallet file is written with `chmod 600` and is stored in config as `runtime.secretsPath`.

Live trading needs CLOB credentials in the same wallet file. Generate or derive them from the owner key:

```bash
polycopy auth init
```

Deposit-wallet setup also needs relayer submit auth. Add either a relayer key:

```bash
RELAYER_API_KEY=...
RELAYER_API_KEY_ADDRESS=0xOwnerAddress
```

or builder credentials:

```bash
POLY_BUILDER_API_KEY=...
POLY_BUILDER_SECRET=...
POLY_BUILDER_PASS_PHRASE=...
```

Do not put private keys, CLOB credentials, relayer keys, or builder secrets in command arguments.

## 5. Prepare Deposit Wallet

First inspect the setup plan:

```bash
polycopy setup-account --usd 5
```

Then execute the setup:

```bash
polycopy setup-account --usd 5 --execute --init-relayer-auth
```

This derives the deterministic deposit wallet, deploys it through the relayer if needed, moves owner pUSD into it, wraps owner USDC.e if pUSD is short, submits deposit-wallet trading approvals, syncs the CLOB balance cache, and persists the live account config on success. The owner wallet still needs enough pUSD or USDC.e for the target `--usd` amount and enough POL for any owner-sent funding/wrap transactions.

## 6. Run Live

```bash
polycopy copytrade 0xLEADER --duration-minutes 1
```

The CLI will prompt:

```text
Type LIVE to enable real order submission:
```

Defaults are intentionally conservative:

- `copyPct=0.10`
- BUY-only unless `--enable-sell` is passed
- confirmed logs only
- `confirmationDepth=2`
- one live order at a time

## Common Copytrade Options

These options work in both dry-run and live mode:

| Option | Use |
|--------|-----|
| `--duration-minutes <n>` | How long to run |
| `--copy-pct <decimal>` | Copy size, for example `0.05` |
| `--enable-sell` | Copy sell fills too |
| `--leaders 0xA,0xB` | Copy multiple leaders |
| `--config <path>` | Load leaders and settings from a config file instead of CLI args only |
| `--http-fallback` | Use HTTP polling instead of WebSocket detection |
| `--submit-only` | Skip ingestion; only recover and submit existing decisions |
| `--max-cycles <n>` | Submit-only cycle cap when `--submit-only` is set |
| `--db <path>` | Write SQLite state somewhere specific |
| `--log <path>` | Write JSONL logs somewhere specific |

Examples:

```bash
polycopy copytrade 0xLEADER --dry-run --copy-pct 0.05 --duration-minutes 5
polycopy copytrade 0xLEADER --secrets .env --copy-pct 0.05 --duration-minutes 10
polycopy copytrade 0xLEADER_A 0xLEADER_B --dry-run --duration-minutes 5
polycopy copytrade --leaders 0xLEADER_A,0xLEADER_B --secrets .env --duration-minutes 10
polycopy copytrade --config ~/.config/polycopy/config.json --secrets .env --duration-minutes 1
```

## Monitor And Stop

Run these from the same directory you used for `copytrade`, unless you passed a custom `--db` path:

```bash
polycopy status
polycopy decisions list
polycopy orders list
```

Emergency stop:

```bash
polycopy kill-switch enable
```

Resume after investigation:

```bash
polycopy kill-switch disable
```

## Files

Default paths:

| Data | Path |
|------|------|
| Config file | `~/.config/polycopy/config.json` |
| RPC list | `~/.config/polycopy/rpc.json` |
| SQLite DB | `./.polycopy/polycopy.db` |
| Logs | `./.polycopy/logs/` |
| Kill switch | `./.polycopy/kill.switch` |

Optional path overrides:

```bash
POLYCOPY_CONFIG=~/.config/polycopy/config.json
POLYCOPY_RPC_PATH=./rpc.json
POLYCOPY_DATA_DIR=./.polycopy
POLYCOPY_DB_PATH=./.polycopy/polycopy.db
POLYCOPY_LOG_DIR=./.polycopy/logs
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| `rpc url not configured` | Run `polycopy rpc add <url>` |
| WebSocket connection fails | Add `--http-fallback` |
| `live requires PRIVATE_KEY and CLOB credentials` | Fill `.env`, then pass `--secrets .env` |
| `.env must not be group/world-readable` | Run `chmod 600 .env` |
| `KILL_SWITCH_ACTIVE` | Inspect with `polycopy status`, then run `polycopy kill-switch disable` when ready |

## Development Checks

```bash
npm run typecheck
npm test
npm run build
polycopy verify --fixture all
```
