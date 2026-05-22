import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Hex, RpcAdapter } from "../adapters/types.js";
import type { Config } from "../config/schema.js";
import type { SqliteDatabase } from "../db/client.js";
import { tripImmediateHaltBreaker } from "../execution/circuit-breaker.js";
import { assertClockSkew, assertHttpsLiveRpcUrls, checkRpcHealth } from "./rpc-health.js";

export type LiveStartupCheckArgs = {
  config: Config;
  configPath: string;
  envPath: string;
  db: SqliteDatabase;
  primaryRpc: RpcAdapter;
  fallbackRpc: RpcAdapter;
  nowMs?: number;
  skipRpcHealth?: boolean;
};

export async function assertLiveStartupReady(args: LiveStartupCheckArgs): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  assertRpcProviders(args.config);
  assertHttpsLiveRpcUrls(args.config);
  await assertTrustedPaths({
    paths: [
      resolve(args.envPath),
      resolve(args.configPath),
      resolve(args.config.runtime.dbPath),
      `${resolve(args.config.runtime.dbPath)}-wal`,
      `${resolve(args.config.runtime.dbPath)}-shm`,
      resolve(args.config.runtime.lockPath),
      resolve(args.config.runtime.logDir),
      resolve(args.config.runtime.dataDir),
      resolve(args.config.runtime.killSwitchPath)
    ],
    appDirectories: [
      resolve(args.config.runtime.dataDir),
      resolve(args.config.runtime.logDir)
    ]
  });
  await assertConfiguredSmartWalletHasCode(args.config, args.primaryRpc);

  if (!args.skipRpcHealth) {
    const health = await checkRpcHealth({
      primary: args.primaryRpc,
      fallback: args.fallbackRpc,
      nowMs,
      maxLagMs: args.config.rpcProviders.find((provider) => provider.name === "primary")?.maxLagMs ?? 30_000
    });
    if (health.hashDisagreement) {
      tripImmediateHaltBreaker(args.db, "RPC_DISAGREEMENT", { nowIso, details: { errors: health.errors } });
      throw new Error(`live startup RPC disagreement: ${health.errors.join("; ")}`);
    }
    if (!health.ok) {
      throw new Error(`live startup RPC health failed: ${health.errors.join("; ")}`);
    }
    if (health.primaryHead) {
      assertClockSkew({
        blockTimestampMs: health.primaryHead.timestampMs,
        nowMs,
        maxSkewMs: args.config.runtime.clockSkewMaxMs
      });
    }
  }
}

async function assertConfiguredSmartWalletHasCode(config: Config, rpc: RpcAdapter): Promise<void> {
  if (config.account.walletMode === "EOA") return;

  const address =
    config.account.walletMode === "POLY_PROXY"
      ? config.account.orderMakerAddress
      : config.account.orderSignerAddress ?? config.account.orderMakerAddress ?? config.account.funderAddress;
  if (!address) {
    throw new Error(`live startup requires ${config.account.walletMode} wallet address`);
  }

  const code = await rpc.getCode({ address: address as Hex, blockTag: "latest" });
  if (hasBytecode(code)) return;

  const label = config.account.walletMode === "POLY_PROXY" ? "proxy wallet" : "deposit wallet";
  throw new Error(`${config.account.walletMode} ${label} has no on-chain code: ${address}`);
}

function hasBytecode(code: Hex): boolean {
  return code !== "0x" && !/^0x0*$/i.test(code);
}

function assertRpcProviders(config: Config): void {
  const primary = config.rpcProviders.find((provider) => provider.name === "primary")?.url;
  const fallback = config.rpcProviders.find((provider) => provider.name === "fallback")?.url;
  if (!primary) {
    throw new Error("live startup requires rpcProviders primary url");
  }
  if (!fallback) {
    throw new Error("live startup requires rpcProviders fallback url");
  }
}

export function recordVerifyIntegrityPass(db: SqliteDatabase, nowIso = new Date().toISOString()): void {
  db.prepare(
    `
      INSERT OR REPLACE INTO runtime_state (key, value, updated_at)
      VALUES ('verify_integrity.pass', ?, ?)
    `
  ).run(JSON.stringify({ ok: true, at: nowIso }), nowIso);
}

async function assertTrustedPaths(args: { paths: string[]; appDirectories: string[] }): Promise<void> {
  const seen = new Set<string>();
  const appDirectorySet = new Set(args.appDirectories.map((path) => resolve(path)));
  for (const path of args.paths) {
    const normalized = resolve(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    await assertPathComponent(normalized, {
      requireExists: false,
      secretFile: normalized.endsWith(".env") || normalized.endsWith(".db") || normalized.endsWith(".lock"),
      strictDirectory: appDirectorySet.has(normalized)
    });
    await assertParentChain(dirname(normalized));
  }
}

async function assertParentChain(path: string): Promise<void> {
  let current = resolve(path);
  while (current !== dirname(current)) {
    await assertPathComponent(current, { requireExists: true, parentDirectory: true });
    current = dirname(current);
  }
}

async function assertPathComponent(
  path: string,
  args: { requireExists: boolean; parentDirectory?: boolean; secretFile?: boolean; strictDirectory?: boolean }
): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (args.requireExists) {
        throw new Error(`live startup path missing: ${path}`);
      }
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`live startup refuses symlink path: ${path}`);
  }
  if (args.parentDirectory) {
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(`live startup refuses group/world-writable path: ${path}`);
    }
    return;
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`live startup refuses group/world-writable path: ${path}`);
  }
  if (stat.isDirectory() && args.strictDirectory && (stat.mode & 0o777) !== 0o700) {
    throw new Error(`live startup requires mode 0700 directory: ${path}`);
  }
  if (args.secretFile && stat.isFile() && (stat.mode & 0o777) !== 0o600) {
    throw new Error(`live startup requires mode 0600 secret file: ${path}`);
  }
}
