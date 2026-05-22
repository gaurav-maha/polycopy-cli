import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG, DEFAULT_CONFIG_PATH } from "./defaults.js";
import { getDefaultConfigPath } from "./load.js";
import { isRecord } from "./merge.js";
import { configSchema, Config } from "./schema.js";

type JsonRecord = Record<string, unknown>;

export function resolveConfigPath(path?: string): string {
  if (!path || path === DEFAULT_CONFIG_PATH) {
    return getDefaultConfigPath();
  }
  return path.startsWith("~/") ? `${process.env.HOME ?? ""}/${path.slice(2)}` : path;
}

export async function readConfigFile(path: string): Promise<JsonRecord> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) {
      throw new Error("config file must contain a JSON object");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function writeConfigFile(path: string, config: Config): Promise<void> {
  const parsed = configSchema.parse(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
}

export async function createDefaultConfig(path: string): Promise<Config> {
  const parsed = configSchema.parse(DEFAULT_CONFIG);
  await writeConfigFile(path, parsed);
  return parsed;
}
