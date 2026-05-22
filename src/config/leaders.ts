import { getAddress } from "viem";
import type { Config, LeaderProfile } from "./schema.js";
import { MAX_LEADERS } from "./schema.js";

export type HexAddress = `0x${string}`;

function findLeaderProfile(config: Config, wallet: HexAddress): LeaderProfile | undefined {
  if (!config.leaders) return undefined;
  const normalized = getAddress(wallet).toLowerCase();
  for (const [key, profile] of Object.entries(config.leaders)) {
    if (getAddress(key).toLowerCase() === normalized) {
      return profile;
    }
  }
  return undefined;
}

export function normalizeLeaderAddress(address: string): HexAddress {
  return getAddress(address) as HexAddress;
}

export function parseLeadersOption(value: string): HexAddress[] {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error("leaders option must include at least one address");
  }
  const normalized = parts.map((part) => normalizeLeaderAddress(part));
  return [...new Set(normalized.map((address) => address.toLowerCase()))].map(
    (lower) => normalized.find((address) => address.toLowerCase() === lower)!
  );
}

export function isLeaderEnabled(config: Config, wallet: HexAddress): boolean {
  return findLeaderProfile(config, wallet)?.enabled !== false;
}

export function leaderCopyPct(config: Config, wallet: HexAddress): string {
  return findLeaderProfile(config, wallet)?.copyPct ?? config.risk.copyPct;
}

export function leaderMaxDailySpendRaw(config: Config, wallet: HexAddress): string | undefined {
  return findLeaderProfile(config, wallet)?.maxDailySpendPusdRaw;
}

export function resolveActiveLeaders(
  config: Config,
  options?: { leader?: HexAddress; leaders?: HexAddress[] }
): HexAddress[] {
  if (options?.leaders && options.leaders.length > 0) {
    return options.leaders.map((address) => normalizeLeaderAddress(address));
  }
  if (options?.leader) {
    return [normalizeLeaderAddress(options.leader)];
  }
  const configured = config.sourceWallets.map((address) => normalizeLeaderAddress(address));
  return configured.filter((wallet) => isLeaderEnabled(config, wallet));
}

export function assertLeadersForCommand(
  leaders: HexAddress[],
  args: { command: string; configured?: HexAddress[]; requireConfigured?: boolean }
): void {
  if (leaders.length === 0) {
    throw new Error(`${args.command} requires at least one leader wallet`);
  }
  if (leaders.length > MAX_LEADERS) {
    throw new Error(`${args.command} supports at most ${MAX_LEADERS} leader wallets`);
  }
  if (args.requireConfigured === false || !args.configured?.length) {
    return;
  }
  const configured = new Set(args.configured.map((address) => address.toLowerCase()));
  for (const leader of leaders) {
    if (!configured.has(leader.toLowerCase())) {
      throw new Error(`${args.command} leader ${leader} is not configured in sourceWallets`);
    }
  }
}

export function parseLeaderArguments(positionals: string[], leadersOption?: string): HexAddress[] {
  if (leadersOption) {
    return parseLeadersOption(leadersOption);
  }
  if (positionals.length === 0) {
    throw new Error("copytrade requires at least one leader wallet address");
  }
  return parseLeadersOption(positionals.join(","));
}

export function assertSourceWalletsLimit(sourceWallets: HexAddress[]): void {
  if (sourceWallets.length > MAX_LEADERS) {
    throw new Error(`sourceWallets supports at most ${MAX_LEADERS} addresses`);
  }
}
