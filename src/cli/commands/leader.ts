import { Command } from "commander";
import { getAddress } from "viem";
import { assertSourceWalletsLimit, normalizeLeaderAddress } from "../../config/leaders.js";
import { hexAddressSchema } from "../../config/schema.js";
import { loadConfig } from "../../config/load.js";
import type { Config } from "../../config/schema.js";
import { writeConfigFile } from "../../config/persist.js";
import { EXIT_CODES } from "../../errors/exit-codes.js";
import { resolveCliConfigPath } from "../config-path.js";

function loadLeaders(config: Config): `0x${string}`[] {
  return config.sourceWallets.map((address) => normalizeLeaderAddress(address));
}

export function registerLeader(program: Command): void {
  const leader = program.command("leader").description("Manage configured leader wallets");

  leader
    .command("list")
    .description("List configured leader wallets")
    .action(async () => {
      const path = resolveCliConfigPath(program);
      const config = await loadConfig({ command: "leader", configPath: path });
      const wallets = loadLeaders(config);
      const entries = wallets.map((address) => ({
        address,
        enabled: config.leaders?.[address]?.enabled !== false
      }));
      process.stdout.write(`${JSON.stringify({ ok: true, leaders: entries })}\n`);
    });

  leader
    .command("add <address>")
    .description("Add a leader wallet")
    .action(async (address: string) => {
      const path = resolveCliConfigPath(program);
      const parsed = normalizeLeaderAddress(hexAddressSchema.parse(address));
      const config = await loadConfig({ command: "leader", configPath: path });
      const existing = loadLeaders(config);
      if (existing.some((wallet) => wallet.toLowerCase() === parsed.toLowerCase())) {
        process.stderr.write(`${JSON.stringify({ ok: false, error: "LEADER_ALREADY_CONFIGURED", leader: parsed })}\n`);
        process.exit(EXIT_CODES.USAGE_OR_CONFIG);
      }
      const next = [...existing, parsed];
      assertSourceWalletsLimit(next);
      config.sourceWallets = next;
      await writeConfigFile(path, config);
      process.stdout.write(`${JSON.stringify({ ok: true, leader: parsed, leaders: next })}\n`);
    });

  leader
    .command("remove <address>")
    .description("Remove a leader wallet")
    .action(async (address: string) => {
      const path = resolveCliConfigPath(program);
      const parsed = normalizeLeaderAddress(hexAddressSchema.parse(address));
      const config = await loadConfig({ command: "leader", configPath: path });
      const existing = loadLeaders(config);
      const next = existing.filter((wallet) => wallet.toLowerCase() !== parsed.toLowerCase());
      if (next.length === existing.length) {
        process.stderr.write(`${JSON.stringify({ ok: false, error: "LEADER_NOT_CONFIGURED", leader: parsed })}\n`);
        process.exit(EXIT_CODES.USAGE_OR_CONFIG);
      }
      if (next.length === 0) {
        process.stderr.write(`${JSON.stringify({ ok: false, error: "LAST_LEADER_REQUIRED" })}\n`);
        process.exit(EXIT_CODES.USAGE_OR_CONFIG);
      }
      config.sourceWallets = next;
      if (config.leaders) {
        const normalized = parsed.toLowerCase();
        config.leaders = Object.fromEntries(
          Object.entries(config.leaders).filter(([key]) => getAddress(key).toLowerCase() !== normalized)
        );
      }
      await writeConfigFile(path, config);
      process.stdout.write(`${JSON.stringify({ ok: true, leader: parsed, leaders: next })}\n`);
    });

  leader
    .command("set <address>")
    .description("Replace configured leaders with a single wallet")
    .action(async (address: string) => {
      const path = resolveCliConfigPath(program);
      const parsed = normalizeLeaderAddress(hexAddressSchema.parse(address));
      const config = await loadConfig({ command: "leader", configPath: path });
      config.sourceWallets = [parsed];
      await writeConfigFile(path, config);
      process.stdout.write(`${JSON.stringify({ ok: true, leader: parsed, leaders: [parsed] })}\n`);
    });

  leader
    .command("show")
    .description("Show configured leader wallets")
    .option("--leader <address>", "show one configured leader")
    .action(async (options: { leader?: string }) => {
      const path = resolveCliConfigPath(program);
      const config = await loadConfig({ command: "leader", configPath: path });
      const wallets = loadLeaders(config);
      if (options.leader) {
        const parsed = normalizeLeaderAddress(hexAddressSchema.parse(options.leader));
        const match = wallets.find((wallet) => wallet.toLowerCase() === parsed.toLowerCase());
        if (!match) {
          process.stderr.write(`${JSON.stringify({ ok: false, error: "LEADER_NOT_CONFIGURED", leader: parsed })}\n`);
          process.exit(EXIT_CODES.USAGE_OR_CONFIG);
        }
        process.stdout.write(`${JSON.stringify({ ok: true, leader: match })}\n`);
        return;
      }
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          leader: wallets[0] ?? null,
          leaders: wallets
        })}\n`
      );
    });
}
