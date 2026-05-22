import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Hex } from "../adapters/types.js";

export type LiveSecrets = {
  privateKey: Hex;
  clobCreds: {
    key: string;
    secret: string;
    passphrase: string;
  };
  payloadEncryptionKey: Uint8Array;
};

export async function loadPrivateKeyFromEnv(envPath = ".env"): Promise<Hex> {
  const path = resolve(envPath);
  const file = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(`wallet file not found: ${path}; setup-account requires PRIVATE_KEY in this file`);
    }
    throw error;
  });
  if ((file.mode & 0o077) !== 0) {
    throw new Error(`wallet file must not be group/world-readable: ${path}; run chmod 600 ${path}`);
  }

  const values = parseDotEnv(await readFile(path, "utf8"));
  return parsePrivateKey(required(values, "PRIVATE_KEY", `setup-account requires PRIVATE_KEY in wallet file: ${path}`), path);
}

export async function loadLiveSecrets(envPath = ".env"): Promise<LiveSecrets> {
  const path = resolve(envPath);
  const file = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(
        `wallet file not found: ${path}; live requires PRIVATE_KEY, CLOB_API_KEY, CLOB_SECRET, and CLOB_PASS_PHRASE in this file`
      );
    }
    throw error;
  });
  if ((file.mode & 0o077) !== 0) {
    throw new Error(`wallet file must not be group/world-readable for live trading: ${path}; run chmod 600 ${path}`);
  }

  const values = parseDotEnv(await readFile(path, "utf8"));
  const privateKey = parsePrivateKey(required(values, "PRIVATE_KEY", `live requires PRIVATE_KEY in wallet file: ${path}`), path);
  const key = required(values, "CLOB_API_KEY", `live requires CLOB_API_KEY in wallet file: ${path}`);
  const secret = required(values, "CLOB_SECRET", `live requires CLOB_SECRET in wallet file: ${path}`);
  const passphrase = values.CLOB_PASS_PHRASE ?? values.CLOB_PASSPHRASE;
  if (!passphrase) {
    throw new Error(`live requires CLOB_PASS_PHRASE or CLOB_PASSPHRASE in wallet file: ${path}`);
  }

  return {
    privateKey,
    clobCreds: { key, secret, passphrase },
    payloadEncryptionKey: createHash("sha256")
      .update("polycopy-live-payload-v1")
      .update(privateKey)
      .update(secret)
      .digest()
  };
}

function parsePrivateKey(raw: string, path: string): Hex {
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error(`PRIVATE_KEY must be a 32-byte hex value in wallet file: ${path}`);
  }
  return normalized as Hex;
}

function required(values: Record<string, string>, key: string, message: string): string {
  const value = values[key]?.trim();
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function parseDotEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
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
