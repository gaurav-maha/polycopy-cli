import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Hex } from "../adapters/types.js";

export type WalletFileValues = Record<string, string>;

export async function readWalletFile(path: string): Promise<WalletFileValues> {
  const file = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(`wallet file not found: ${path}`);
    }
    throw error;
  });
  if ((file.mode & 0o077) !== 0) {
    throw new Error("wallet file must not be group/world-readable; run chmod 600 <wallet-file>");
  }
  return parseWalletFile(await readFile(path, "utf8"));
}

export async function writeWalletFile(path: string, values: WalletFileValues, options?: { overwrite?: boolean }): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const payload = `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
  await writeFile(path, payload, { mode: 0o600, flag: options?.overwrite ? "w" : "wx" });
  await chmod(path, 0o600);
}

export function parsePrivateKey(raw: string): Hex {
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex value");
  }
  return normalized as Hex;
}

function parseWalletFile(contents: string): WalletFileValues {
  const values: WalletFileValues = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}
