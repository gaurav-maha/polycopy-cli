import type { BlockRef, RpcAdapter } from "../adapters/types.js";
import type { Config } from "../config/schema.js";

export type RpcHealthResult = {
  ok: boolean;
  primaryHead: BlockRef | null;
  fallbackHead: BlockRef | null;
  headAgeMs: number | null;
  hashDisagreement: boolean;
  errors: string[];
};

export async function checkRpcHealth(args: {
  primary: RpcAdapter;
  fallback: RpcAdapter;
  nowMs?: number;
  maxLagMs?: number;
}): Promise<RpcHealthResult> {
  const nowMs = args.nowMs ?? Date.now();
  const maxLagMs = args.maxLagMs ?? 30_000;
  const errors: string[] = [];
  let primaryHead: BlockRef | null = null;
  let fallbackHead: BlockRef | null = null;

  try {
    const chainId = await args.primary.getChainId();
    if (chainId !== 137) {
      errors.push(`primary chainId ${chainId} != 137`);
    }
  } catch (error) {
    errors.push(`primary chainId failed: ${stringifyError(error)}`);
  }

  try {
    const chainId = await args.fallback.getChainId();
    if (chainId !== 137) {
      errors.push(`fallback chainId ${chainId} != 137`);
    }
  } catch (error) {
    errors.push(`fallback chainId failed: ${stringifyError(error)}`);
  }

  try {
    primaryHead = await args.primary.getLatestBlock();
  } catch (error) {
    errors.push(`primary head failed: ${stringifyError(error)}`);
  }

  try {
    fallbackHead = await args.fallback.getLatestBlock();
  } catch (error) {
    errors.push(`fallback head failed: ${stringifyError(error)}`);
  }

  let headAgeMs: number | null = null;
  if (primaryHead) {
    headAgeMs = nowMs - primaryHead.timestampMs;
    if (headAgeMs > maxLagMs) {
      errors.push(`primary head stale: age ${headAgeMs}ms > ${maxLagMs}ms`);
    }
  }

  let hashDisagreement = false;
  if (primaryHead && fallbackHead) {
    const compareHeight = primaryHead.number < fallbackHead.number ? primaryHead.number : fallbackHead.number;
    try {
      const [primaryAtHeight, fallbackAtHeight] = await Promise.all([
        args.primary.getBlock(compareHeight),
        args.fallback.getBlock(compareHeight)
      ]);
      if (primaryAtHeight.hash.toLowerCase() !== fallbackAtHeight.hash.toLowerCase()) {
        hashDisagreement = true;
        errors.push(`rpc hash disagreement at block ${compareHeight.toString()}`);
      }
    } catch (error) {
      errors.push(`rpc hash comparison failed: ${stringifyError(error)}`);
    }
  }

  return {
    ok: errors.length === 0,
    primaryHead,
    fallbackHead,
    headAgeMs,
    hashDisagreement,
    errors
  };
}

export function assertHttpsLiveRpcUrls(config: Config): void {
  for (const provider of config.rpcProviders) {
    if (!provider.url.startsWith("https://")) {
      throw new Error(`live startup requires https RPC url for ${provider.name}`);
    }
  }
}

export function assertClockSkew(args: { blockTimestampMs: number; nowMs?: number; maxSkewMs: number }): void {
  const nowMs = args.nowMs ?? Date.now();
  const futureSkewMs = args.blockTimestampMs - nowMs;
  if (futureSkewMs > args.maxSkewMs) {
    throw new Error(`live startup clock skew ${futureSkewMs}ms exceeds ${args.maxSkewMs}ms`);
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
