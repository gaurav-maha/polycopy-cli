import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_CONFIG, DEFAULT_CONFIG_PATH } from "./defaults.js";
import { mergeDeep } from "./merge.js";
import { Config, configSchema } from "./schema.js";

type LoadConfigArgs = {
  configPath?: string;
  command: string;
  env?: NodeJS.ProcessEnv;
  overrides?: Partial<Config>;
};

function expandHome(path: string): string {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

async function readJsonIfPresent(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function envOverlay(env: NodeJS.ProcessEnv): Partial<Config> {
  const rpcProviders = [];
  if (env.POLYGON_RPC_PRIMARY) {
    rpcProviders.push({ name: "primary" as const, url: env.POLYGON_RPC_PRIMARY, maxLagMs: 30_000, maxLagBlocks: 1 });
  }
  if (env.POLYGON_RPC_FALLBACK) {
    rpcProviders.push({ name: "fallback" as const, url: env.POLYGON_RPC_FALLBACK, maxLagMs: 30_000, maxLagBlocks: 1 });
  }
  const runtime: Partial<Config["runtime"]> = {};
  if (env.POLYCOPY_DATA_DIR) runtime.dataDir = env.POLYCOPY_DATA_DIR;
  if (env.POLYCOPY_DB_PATH) runtime.dbPath = env.POLYCOPY_DB_PATH;
  if (env.POLYCOPY_LOG_DIR) runtime.logDir = env.POLYCOPY_LOG_DIR;
  if (env.KILL_SWITCH_PATH) runtime.killSwitchPath = env.KILL_SWITCH_PATH;
  return {
    ...(rpcProviders.length ? { rpcProviders } : {}),
    ...(Object.keys(runtime).length ? { runtime } : {})
  } as Partial<Config>;
}

export function getDefaultConfigPath(): string {
  return expandHome(DEFAULT_CONFIG_PATH);
}

export function getConfigParent(path: string): string {
  return dirname(expandHome(path));
}

export async function loadConfig(args: LoadConfigArgs): Promise<Config> {
  const env = args.env ?? process.env;
  const configPath = expandHome(args.configPath ?? process.env.POLYCOPY_CONFIG ?? DEFAULT_CONFIG_PATH);
  const fileConfig = await readJsonIfPresent(configPath);
  const raw = mergeDeep(mergeDeep(mergeDeep(DEFAULT_CONFIG, fileConfig), envOverlay(env)), args.overrides ?? {});
  return configSchema.parse(raw);
}
