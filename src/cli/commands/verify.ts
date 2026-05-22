import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPublicClient, http, type Abi } from "viem";
import { polygon } from "viem/chains";
import { ClobClient } from "@polymarket/clob-client-v2";
import { verifyIntegrity } from "../../verify/integrity.js";
import { verifyFixtureManifest } from "../../verify/fixtures.js";
import { EXIT_CODES } from "../../errors/exit-codes.js";
import { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { openDatabase } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { recordVerifyIntegrityPass } from "../../live/startup-checks.js";
import { loadConfig } from "../../config/load.js";
import { resolveCliConfigPath } from "../config-path.js";

function stringifyJson(value: unknown, space: number): string {
  return JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry), space);
}

export function registerVerify(program: Command): void {
  program
    .command("verify")
    .description("Verify protocol constants and fixtures")
    .option("--fixture <name>", "fixture id or all", "all")
    .option("--write-snapshot", "write live getter snapshot")
    .action(async (options: { fixture: string; writeSnapshot?: boolean }) => {
      const rpcUrl = process.env.POLYGON_RPC_PRIMARY;
      const client =
        rpcUrl && options.writeSnapshot
          ? createPublicClient({
              chain: polygon,
              transport: http(rpcUrl)
            })
          : undefined;

      const [integrity, fixtures, getterSnapshot] = await Promise.all([
        verifyIntegrity({
          getterSnapshotPath: "fixtures/getter_snapshot.json",
          writeSnapshot: options.writeSnapshot,
          rpc: client
            ? {
                getCode: async (args) => {
                  const code =
                    typeof args.blockTag === "bigint"
                      ? await client.getCode({ address: args.address, blockNumber: args.blockTag })
                      : await client.getCode({ address: args.address, blockTag: "latest" });
                  return code ?? "0x";
                },
                readContract: (args) =>
                  client.readContract({
                    address: args.address,
                    abi: args.abi as Abi,
                    functionName: args.functionName,
                    args: args.args as readonly unknown[] | undefined,
                    blockTag: args.blockTag === "latest" || args.blockTag === undefined ? "latest" : undefined,
                    blockNumber: typeof args.blockTag === "bigint" ? args.blockTag : undefined
                  })
              }
            : undefined
        }),
        verifyFixtureManifest({ manifestPath: "fixtures/manifest.json", fixture: options.fixture }),
        readGetterSnapshotChecks("fixtures/getter_snapshot.json")
      ]);

      const sdkCheck = await verifySdkInit();
      const checks = [
        ...integrity.checks.map((entry) => ({ scope: "integrity", ...entry })),
        ...getterSnapshot,
        ...fixtures.checks.map((entry) => ({ scope: "fixture", ...entry })),
        sdkCheck
      ];
      const ok = integrity.ok && fixtures.ok && getterSnapshot.every((entry) => entry.ok) && sdkCheck.ok;
      const payload = { ok, fixture: options.fixture, cases: fixtures.cases, checks };
      process.stdout.write(`${stringifyJson(payload, program.optsWithGlobals().json ? 0 : 2)}\n`);
      if (ok) {
        try {
          const config = await loadConfig({ command: "verify", configPath: resolveCliConfigPath(program) });
          await mkdir(dirname(config.runtime.dbPath), { recursive: true, mode: 0o700 });
          const db = openDatabase(config.runtime.dbPath);
          runMigrations(db);
          recordVerifyIntegrityPass(db);
          db.close();
        } catch {
          // verify still succeeds even if runtime db is unavailable
        }
      }
      if (!ok) {
        process.exit(EXIT_CODES.VERIFY_FAILED);
      }
    });
}

async function readGetterSnapshotChecks(path: string): Promise<Array<{ scope: string; name: string; ok: boolean; details?: unknown }>> {
  try {
    const snapshot = JSON.parse(await readFile(resolve(path), "utf8")) as {
      standardExchange: { bytecodePresent: boolean; getCollateral: string; getCtfCollateral: string };
      negRiskExchange: { bytecodePresent: boolean; getCtfCollateral: string };
      orderTypehash: string;
      orderFilledTopic: string;
    };
    return [
      { scope: "getter_snapshot", name: "bytecode_present", ok: snapshot.standardExchange.bytecodePresent && snapshot.negRiskExchange.bytecodePresent },
      { scope: "getter_snapshot", name: "standard_getCollateral", ok: snapshot.standardExchange.getCollateral.toLowerCase() === "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb" },
      { scope: "getter_snapshot", name: "neg_risk_getCtfCollateral", ok: snapshot.negRiskExchange.getCtfCollateral.toLowerCase() === "0x3a3bd7bb9528e159577f7c2e685cc81a765002e2" },
      { scope: "getter_snapshot", name: "order_typehash", ok: snapshot.orderTypehash === "0xbb86318a2138f5fa8ae32fbe8e659f8fcf13cc6ae4014a707893055433818589" },
      { scope: "getter_snapshot", name: "order_filled_topic", ok: snapshot.orderFilledTopic.length === 66 }
    ];
  } catch (error) {
    return [{ scope: "getter_snapshot", name: "snapshot_file", ok: false, details: String(error) }];
  }
}

async function verifySdkInit(): Promise<{ scope: string; name: string; ok: boolean; details?: unknown }> {
  try {
    const client = new ClobClient({ host: "https://clob.polymarket.com", chain: 137, signatureType: 0 });
    return { scope: "sdk", name: "clob_client_v2_init", ok: typeof client === "object" && client !== null };
  } catch (error) {
    return { scope: "sdk", name: "clob_client_v2_init", ok: false, details: String(error) };
  }
}
