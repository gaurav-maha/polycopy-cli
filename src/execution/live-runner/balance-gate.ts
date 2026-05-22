import type { ClobRestAdapter, Hex, RpcAdapter } from "../../adapters/types.js";
import { CTF, PUSD } from "../../constants/chain.js";
import type { SqliteDatabase } from "../../db/client.js";
import { loadSellInventory } from "../../risk/inventory.js";
import { loadActivePUsdReservationsRaw, loadActiveSellInventoryReservationsRaw } from "../../risk/reservations.js";
import type { BalanceGateSnapshot, SellInventoryGateSnapshot } from "./types.js";

const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "allowance", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }
] as const;

export async function assertBuyBalanceCoverage(
  db: SqliteDatabase,
  args: {
    clob: ClobRestAdapter;
    rpc: RpcAdapter;
    funder: Hex;
    spender: Hex;
    signatureType: 0 | 1 | 3;
    currentOrderRaw: bigint;
    currentFeeHeadroomRaw?: bigint;
    toleranceRaw: bigint;
    clobCacheMaxAgeMs: number;
    nowMs: number;
  }
): Promise<BalanceGateSnapshot> {
  const [onchainPusdRaw, allowanceRaw, clob] = await Promise.all([
    args.rpc.readContract<bigint>({
      address: PUSD,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [args.funder]
    }),
    args.rpc.readContract<bigint>({
      address: PUSD,
      abi: erc20Abi,
      functionName: "allowance",
      args: [args.funder, args.spender]
    }),
    args.clob.getBalanceAllowance({
      assetType: "COLLATERAL",
      expectedFunder: args.funder,
      expectedSpender: args.spender,
      expectedSignatureType: args.signatureType
    })
  ]);
  const clobPusdRaw = BigInt(clob.balanceRaw);
  const clobAllowanceRaw = BigInt(clob.allowanceRaw);
  const currentRequiredRaw = args.currentOrderRaw + (args.currentFeeHeadroomRaw ?? 0n);
  const requiredRaw = loadActivePUsdReservationsRaw(db) + currentRequiredRaw;
  const cacheAgeMs = args.nowMs - clob.receivedAtMs;
  const balanceDelta = onchainPusdRaw > clobPusdRaw ? onchainPusdRaw - clobPusdRaw : clobPusdRaw - onchainPusdRaw;
  const allowance = allowanceRaw < clobAllowanceRaw ? allowanceRaw : clobAllowanceRaw;
  if (cacheAgeMs > args.clobCacheMaxAgeMs) {
    throw new Error("CLOB cache is stale");
  }
  if (balanceDelta > args.toleranceRaw) {
    throw new Error("CLOB cache balance mismatch");
  }
  if (onchainPusdRaw < requiredRaw || clobPusdRaw < requiredRaw || allowance < requiredRaw) {
    throw new Error(
      [
        "INSUFFICIENT_PUSD_AVAILABLE:",
        `requiredRaw=${requiredRaw.toString()}`,
        `currentOrderRaw=${args.currentOrderRaw.toString()}`,
        `currentFeeHeadroomRaw=${(args.currentFeeHeadroomRaw ?? 0n).toString()}`,
        `onchainPusdRaw=${onchainPusdRaw.toString()}`,
        `clobPusdRaw=${clobPusdRaw.toString()}`,
        `allowanceRaw=${allowance.toString()}`
      ].join(" ")
    );
  }
  return { onchainPusdRaw, clobPusdRaw, allowanceRaw: allowance, requiredRaw };
}

const erc1155BalanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { type: "address", name: "account" },
      { type: "uint256", name: "id" }
    ],
    outputs: [{ type: "uint256" }]
  }
] as const;

export async function assertSellInventoryCoverage(
  db: SqliteDatabase,
  args: {
    rpc: RpcAdapter;
    owner: Hex;
    tokenId: string;
    currentOrderSizeRaw: bigint;
    maxPositionAgeMs: number;
    nowMs: number;
  }
): Promise<SellInventoryGateSnapshot> {
  const loaded = loadSellInventory(db, {
    tokenId: args.tokenId,
    nowMs: args.nowMs,
    maxPositionAgeMs: args.maxPositionAgeMs
  });
  if (!loaded.ok) {
    throw new Error(`sell inventory unavailable: ${loaded.reason}`);
  }

  const onchainSharesRaw = BigInt(
    await args.rpc.readContract<bigint>({
      address: CTF,
      abi: erc1155BalanceOfAbi,
      functionName: "balanceOf",
      args: [args.owner, args.tokenId]
    })
  );
  const activeReservedSharesRaw = loadActiveSellInventoryReservationsRaw(db, args.tokenId);
  const requiredSharesRaw = activeReservedSharesRaw + args.currentOrderSizeRaw;
  const availableSharesRaw = BigInt(loaded.inventory.sharesRaw);
  if (availableSharesRaw < args.currentOrderSizeRaw) {
    throw new Error("sell inventory below active reservations");
  }
  if (onchainSharesRaw < requiredSharesRaw) {
    throw new Error("on-chain shares below active sell reservations");
  }

  return {
    onchainSharesRaw,
    availableSharesRaw,
    activeReservedSharesRaw,
    requiredSharesRaw
  };
}
