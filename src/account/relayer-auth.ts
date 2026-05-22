import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "../adapters/types.js";

const defaultGammaUrl = "https://gamma-api.polymarket.com";
const defaultRelayerUrl = "https://relayer-v2.polymarket.com";
const polymarketDomain = "polymarket.com";
const polymarketUri = "https://polymarket.com";
const siweStatement = "Welcome to Polymarket! Sign to connect.";
const sessionTtlMs = 604_800_000;

export type CreatedRelayerApiKey = {
  apiKey: string;
  address: string;
  createdAt?: string;
  updatedAt?: string;
};

export async function createRelayerApiKeyWithGammaAuth(args: {
  privateKey: Hex;
  gammaUrl?: string;
  relayerUrl?: string;
  fetchFn?: typeof fetch;
  nowMs?: number;
}): Promise<CreatedRelayerApiKey> {
  const fetchFn = args.fetchFn ?? fetch;
  const gammaUrl = (args.gammaUrl ?? defaultGammaUrl).replace(/\/$/, "");
  const relayerUrl = (args.relayerUrl ?? defaultRelayerUrl).replace(/\/$/, "");
  const account = privateKeyToAccount(args.privateKey);
  const owner = getAddress(account.address);
  const jar = new CookieJar();

  const nonceResponse = await requestJson<{ nonce?: string } | string>(
    fetchFn,
    `${gammaUrl}/nonce`,
    { method: "GET", headers: { Accept: "application/json" } },
    jar
  );
  const nonce = typeof nonceResponse === "string" ? nonceResponse : nonceResponse.nonce;
  if (!nonce) {
    throw new Error("Gamma nonce response missing nonce");
  }

  const token = await signGammaAuthToken({
    privateKey: args.privateKey,
    address: owner,
    nonce,
    nowMs: args.nowMs ?? Date.now()
  });
  await requestJson<unknown>(
    fetchFn,
    `${gammaUrl}/login`,
    { method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${token}` } },
    jar
  );

  const key = await requestJson<{ apiKey?: string; key?: string; address?: string; createdAt?: string; updatedAt?: string }>(
    fetchFn,
    `${relayerUrl}/relayer/api/auth`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{}"
    },
    jar
  );
  const apiKey = key.apiKey ?? key.key;
  if (!apiKey) {
    throw new Error("Relayer API key response missing apiKey");
  }
  return {
    apiKey,
    address: getAddress(key.address ?? owner),
    createdAt: key.createdAt,
    updatedAt: key.updatedAt
  };
}

export async function signGammaAuthToken(args: {
  privateKey: Hex;
  address: string;
  nonce: string;
  nowMs: number;
}): Promise<string> {
  const account = privateKeyToAccount(args.privateKey);
  const issuedAt = new Date(args.nowMs).toISOString();
  const expirationTime = new Date(args.nowMs + sessionTtlMs).toISOString();
  const fields = {
    domain: polymarketDomain,
    address: getAddress(args.address),
    statement: siweStatement,
    uri: polymarketUri,
    version: "1",
    chainId: 137,
    nonce: args.nonce,
    issuedAt,
    expirationTime
  };
  const message = createSiweMessage(fields);
  const signature = await account.signMessage({ message });
  return Buffer.from(`${JSON.stringify(fields)}:::${signature}`).toString("base64");
}

function createSiweMessage(fields: {
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
}): string {
  const statement = fields.statement ? `${fields.statement}\n` : "";
  let footer =
    `URI: ${fields.uri}\n` +
    `Version: ${fields.version}\n` +
    `Chain ID: ${fields.chainId}\n` +
    `Nonce: ${fields.nonce}\n` +
    `Issued At: ${new Date(fields.issuedAt).toISOString()}`;
  if (fields.expirationTime) {
    footer += `\nExpiration Time: ${new Date(fields.expirationTime).toISOString()}`;
  }
  return `${fields.domain} wants you to sign in with your Ethereum account:\n${getAddress(fields.address)}\n\n${statement}\n${footer}`;
}

async function requestJson<T>(fetchFn: typeof fetch, url: string, init: RequestInit, jar: CookieJar): Promise<T> {
  const headers = new Headers(init.headers);
  const cookie = jar.header();
  if (cookie) {
    headers.set("Cookie", cookie);
  }
  const response = await fetchFn(url, { ...init, headers });
  jar.capture(response.headers);
  const body = await response.text();
  const parsed = body ? parseJson(body) : {};
  if (!response.ok) {
    const message = typeof parsed.error === "string" ? parsed.error : body;
    throw new Error(`${init.method ?? "GET"} ${new URL(url).pathname} HTTP ${response.status}: ${message}`);
  }
  return parsed as T;
}

function parseJson(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { raw: body };
  }
}

class CookieJar {
  private readonly values = new Map<string, string>();

  capture(headers: Headers): void {
    const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
    const raw = withGetSetCookie.getSetCookie?.() ?? [];
    const fallback = headers.get("set-cookie");
    const setCookies = raw.length > 0 ? raw : fallback ? [fallback] : [];
    for (const setCookie of setCookies) {
      for (const cookie of setCookie.split(/,(?=[^;,]+=)/)) {
        const [pair] = cookie.split(";");
        const separator = pair.indexOf("=");
        if (separator <= 0) continue;
        this.values.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      }
    }
  }

  header(): string {
    return Array.from(this.values, ([key, value]) => `${key}=${value}`).join("; ");
  }
}
