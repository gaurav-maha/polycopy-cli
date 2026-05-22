import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./schema.js";
import { getDefaultConfigPath } from "./load.js";

export type PersistedRpcStore = {
  urls: string[];
  updatedAt: string;
};

/** @deprecated use PersistedRpcStore */
export type PersistedRpc = {
  url: string;
  updatedAt: string;
};

export function getDefaultRpcPath(): string {
  return join(dirname(getDefaultConfigPath()), "rpc.json");
}

export function resolveRpcPath(path?: string): string {
  if (path) return path;
  if (process.env.POLYCOPY_RPC_PATH) return process.env.POLYCOPY_RPC_PATH;
  return getDefaultRpcPath();
}

export function assertRpcUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://")) {
    throw new Error("rpc url must start with http:// or https://");
  }
  return trimmed;
}

function rpcProviderName(index: number): Config["rpcProviders"][number]["name"] {
  if (index === 0) return "primary";
  if (index === 1) return "fallback";
  return `fallback-${index}` as Config["rpcProviders"][number]["name"];
}

export function rpcProvidersFromUrls(urls: string[]): Config["rpcProviders"] {
  if (urls.length === 0) {
    throw new Error("at least one rpc url is required");
  }
  return urls.map((url, index) => ({
    name: rpcProviderName(index),
    url: assertRpcUrl(url),
    maxLagMs: 30_000,
    maxLagBlocks: 1
  }));
}

function normalizeUrlList(urls: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const url of urls) {
    const value = assertRpcUrl(url);
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

function parsePersistedRpcStore(raw: unknown): PersistedRpcStore | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as { urls?: unknown; url?: unknown; updatedAt?: unknown };
  if (Array.isArray(record.urls)) {
    const urls = normalizeUrlList(record.urls.filter((entry): entry is string => typeof entry === "string"));
    if (urls.length === 0) return undefined;
    return {
      urls,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString()
    };
  }
  if (typeof record.url === "string") {
    return {
      urls: normalizeUrlList([record.url]),
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString()
    };
  }
  return undefined;
}

async function writePersistedRpcStore(store: PersistedRpcStore, path?: string): Promise<PersistedRpcStore> {
  const resolved = resolveRpcPath(path);
  const payload: PersistedRpcStore = {
    urls: normalizeUrlList(store.urls),
    updatedAt: new Date().toISOString()
  };
  if (payload.urls.length === 0) {
    throw new Error("at least one rpc url is required");
  }
  await mkdir(dirname(resolved), { recursive: true, mode: 0o700 });
  const tmp = `${resolved}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(tmp, resolved);
  return payload;
}

export async function readPersistedRpcs(path?: string): Promise<PersistedRpcStore | undefined> {
  const resolved = resolveRpcPath(path);
  try {
    return parsePersistedRpcStore(JSON.parse(await readFile(resolved, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** @deprecated use readPersistedRpcs */
export async function readPersistedRpc(path?: string): Promise<PersistedRpc | undefined> {
  const store = await readPersistedRpcs(path);
  if (!store) return undefined;
  return { url: store.urls[0]!, updatedAt: store.updatedAt };
}

export async function writePersistedRpc(url: string, path?: string): Promise<PersistedRpcStore> {
  return writePersistedRpcStore({ urls: [url], updatedAt: new Date().toISOString() }, path);
}

export async function addPersistedRpc(url: string, path?: string): Promise<PersistedRpcStore> {
  const existing = (await readPersistedRpcs(path))?.urls ?? [];
  return writePersistedRpcStore({ urls: [...existing, url], updatedAt: new Date().toISOString() }, path);
}

export async function removePersistedRpc(url: string, path?: string): Promise<PersistedRpcStore> {
  const normalized = assertRpcUrl(url).toLowerCase();
  const existing = (await readPersistedRpcs(path))?.urls ?? [];
  const next = existing.filter((entry) => entry.toLowerCase() !== normalized);
  if (next.length === existing.length) {
    throw new Error(`rpc url not configured: ${url}`);
  }
  if (next.length === 0) {
    const resolved = resolveRpcPath(path);
    try {
      await unlink(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return { urls: [], updatedAt: new Date().toISOString() };
  }
  return writePersistedRpcStore({ urls: next, updatedAt: new Date().toISOString() }, path);
}

function envRpcUrls(env: NodeJS.ProcessEnv): string[] {
  const urls: string[] = [];
  if (env.POLYGON_RPC_PRIMARY?.trim()) urls.push(env.POLYGON_RPC_PRIMARY);
  if (env.POLYGON_RPC_FALLBACK?.trim()) urls.push(env.POLYGON_RPC_FALLBACK!);
  return normalizeUrlList(urls);
}

export async function resolveRpcUrls(args?: {
  override?: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
}): Promise<string[]> {
  const env = args?.env ?? process.env;
  if (args?.override?.trim()) {
    return normalizeUrlList([args.override]);
  }
  const persisted = (await readPersistedRpcs(args?.path))?.urls ?? [];
  if (persisted.length > 0) {
    return persisted;
  }
  const fromEnv = envRpcUrls(env);
  if (fromEnv.length > 0) {
    return fromEnv;
  }
  throw new Error("rpc url not configured; run polycopy rpc add <url>");
}

export async function resolveRpcUrl(args?: {
  override?: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
}): Promise<string> {
  const urls = await resolveRpcUrls(args);
  return urls[0]!;
}
