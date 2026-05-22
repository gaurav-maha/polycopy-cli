import type { Hex, RpcAdapter } from "../adapters/types.js";

export type SettlementReceiptWaitResult = {
  ready: boolean;
  received: Hex[];
  pending: Hex[];
  errors: Record<string, string>;
};

const defaultTimeoutMs = 20_000;
const defaultPollMs = 500;

export async function waitForSettlementReceipts(
  rpc: RpcAdapter,
  txHashes: Hex[],
  args: { timeoutMs?: number; pollMs?: number } = {}
): Promise<SettlementReceiptWaitResult> {
  const pending = uniqueTxHashes(txHashes);
  if (pending.length === 0) {
    return { ready: true, received: [], pending: [], errors: {} };
  }

  const timeoutMs = Math.max(0, args.timeoutMs ?? defaultTimeoutMs);
  const pollMs = Math.max(0, args.pollMs ?? defaultPollMs);
  const deadlineMs = Date.now() + timeoutMs;
  const received = new Set<Hex>();
  const errors: Record<string, string> = {};
  let remaining = pending;

  while (remaining.length > 0) {
    const nextRemaining: Hex[] = [];
    for (const txHash of remaining) {
      try {
        await rpc.getTransactionReceipt(txHash);
        received.add(txHash);
        delete errors[txHash];
      } catch (error) {
        errors[txHash] = stringifyError(error);
        nextRemaining.push(txHash);
      }
    }

    if (nextRemaining.length === 0) {
      return { ready: true, received: [...received], pending: [], errors };
    }

    const nowMs = Date.now();
    if (timeoutMs === 0 || pollMs === 0 || nowMs >= deadlineMs) {
      return { ready: false, received: [...received], pending: nextRemaining, errors };
    }

    await sleep(Math.min(pollMs, deadlineMs - nowMs));
    remaining = nextRemaining;
  }

  return { ready: true, received: [...received], pending: [], errors };
}

export function formatSettlementReceiptWait(result: SettlementReceiptWaitResult): string {
  const pending = result.pending.join(",");
  const errors = result.pending
    .map((txHash) => {
      const error = result.errors[txHash];
      return error ? `${txHash}:${error}` : null;
    })
    .filter((entry): entry is string => entry !== null)
    .join("; ");
  return errors.length > 0
    ? `SETTLEMENT_RECEIPT_PENDING: pending=${pending} errors=${errors}`
    : `SETTLEMENT_RECEIPT_PENDING: pending=${pending}`;
}

function uniqueTxHashes(txHashes: Hex[]): Hex[] {
  const seen = new Set<string>();
  const unique: Hex[] = [];
  for (const txHash of txHashes) {
    const key = txHash.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(txHash);
  }
  return unique;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
