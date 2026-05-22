export type RpcQuantity = string | number | bigint;

export function rpcQuantityToNumber(value: RpcQuantity, fieldName: string): number {
  const parsed =
    typeof value === "bigint"
      ? value
      : typeof value === "string"
        ? BigInt(value)
        : BigInt(value);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${fieldName} RPC quantity is outside safe integer range`);
  }
  return Number(parsed);
}
