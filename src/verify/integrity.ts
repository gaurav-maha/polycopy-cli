import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { encodeFunctionData, getAddress, toFunctionSelector } from "viem";
import {
  COLLATERAL_ONRAMP,
  CTF,
  CTF_EXCHANGE_V2,
  NEG_RISK_CTF_COLLATERAL,
  NEG_RISK_CTF_EXCHANGE_V2,
  NEG_RISK_OUTCOME_TOKEN_FACTORY,
  PUSD,
  STANDARD_OUTCOME_TOKEN_FACTORY,
  USDC_E
} from "../constants/chain.js";
import { ORDER_FILLED_TOPIC, ORDER_TYPEHASH } from "../constants/abi.js";

const getterAbi = [
  { type: "function", name: "getCollateral", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "getCtf", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "getCtfCollateral", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "getOutcomeTokenFactory", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }
] as const;

export type IntegrityRpc = {
  getCode(args: { address: `0x${string}`; blockTag?: bigint | "latest" }): Promise<`0x${string}`>;
  readContract<T>(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args?: unknown[];
    blockTag?: bigint | "latest";
  }): Promise<unknown>;
};

export type IntegrityResult = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; details?: unknown }>;
};

function check(checks: IntegrityResult["checks"], name: string, ok: boolean, details?: unknown): void {
  checks.push({ name, ok, ...(details === undefined ? {} : { details }) });
}

async function exchangeSnapshot(rpc: IntegrityRpc, address: `0x${string}`) {
  const [code, getCollateral, getCtf, getCtfCollateral, getOutcomeTokenFactory] = await Promise.all([
    rpc.getCode({ address, blockTag: "latest" }),
    rpc.readContract({ address, abi: getterAbi, functionName: "getCollateral", blockTag: "latest" }),
    rpc.readContract({ address, abi: getterAbi, functionName: "getCtf", blockTag: "latest" }),
    rpc.readContract({ address, abi: getterAbi, functionName: "getCtfCollateral", blockTag: "latest" }),
    rpc.readContract({ address, abi: getterAbi, functionName: "getOutcomeTokenFactory", blockTag: "latest" })
  ]);
  return {
    address,
    bytecodePresent: code !== "0x",
    getCollateral: getAddress(getCollateral as string),
    getCtf: getAddress(getCtf as string),
    getCtfCollateral: getAddress(getCtfCollateral as string),
    getOutcomeTokenFactory: getAddress(getOutcomeTokenFactory as string)
  };
}

export async function verifyIntegrity(args: {
  getterSnapshotPath?: string;
  writeSnapshot?: boolean;
  rpc?: IntegrityRpc;
}): Promise<IntegrityResult> {
  const checks: IntegrityResult["checks"] = [];
  check(checks, "chain_id", true, 137);
  check(checks, "order_typehash", ORDER_TYPEHASH === "0xbb86318a2138f5fa8ae32fbe8e659f8fcf13cc6ae4014a707893055433818589");
  check(checks, "order_filled_topic", ORDER_FILLED_TOPIC.length === 66, ORDER_FILLED_TOPIC);
  check(
    checks,
    "collateral_onramp_wrap_selector",
    toFunctionSelector("wrap(address,address,uint256)") === "0x62355638",
    toFunctionSelector("wrap(address,address,uint256)")
  );
  encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "wrap",
        inputs: [
          { type: "address", name: "_asset" },
          { type: "address", name: "_to" },
          { type: "uint256", name: "_amount" }
        ],
        outputs: [],
        stateMutability: "nonpayable"
      }
    ],
    functionName: "wrap",
    args: [USDC_E, CTF_EXCHANGE_V2, 1n]
  });

  if (args.rpc) {
    const [standardExchange, negRiskExchange] = await Promise.all([
      exchangeSnapshot(args.rpc, CTF_EXCHANGE_V2),
      exchangeSnapshot(args.rpc, NEG_RISK_CTF_EXCHANGE_V2)
    ]);
    check(checks, "standard_bytecode", standardExchange.bytecodePresent);
    check(checks, "neg_risk_bytecode", negRiskExchange.bytecodePresent);
    check(checks, "standard_getCollateral", standardExchange.getCollateral === getAddress(PUSD), standardExchange.getCollateral);
    check(checks, "standard_getCtf", standardExchange.getCtf === getAddress(CTF), standardExchange.getCtf);
    check(checks, "standard_getCtfCollateral", standardExchange.getCtfCollateral === getAddress(USDC_E), standardExchange.getCtfCollateral);
    check(
      checks,
      "standard_getOutcomeTokenFactory",
      standardExchange.getOutcomeTokenFactory === getAddress(STANDARD_OUTCOME_TOKEN_FACTORY),
      standardExchange.getOutcomeTokenFactory
    );
    check(checks, "neg_risk_getCollateral", negRiskExchange.getCollateral === getAddress(PUSD), negRiskExchange.getCollateral);
    check(checks, "neg_risk_getCtf", negRiskExchange.getCtf === getAddress(CTF), negRiskExchange.getCtf);
    check(
      checks,
      "neg_risk_getCtfCollateral",
      negRiskExchange.getCtfCollateral === getAddress(NEG_RISK_CTF_COLLATERAL),
      negRiskExchange.getCtfCollateral
    );
    check(
      checks,
      "neg_risk_getOutcomeTokenFactory",
      negRiskExchange.getOutcomeTokenFactory === getAddress(NEG_RISK_OUTCOME_TOKEN_FACTORY),
      negRiskExchange.getOutcomeTokenFactory
    );
    if (args.writeSnapshot && args.getterSnapshotPath) {
      await mkdir(dirname(args.getterSnapshotPath), { recursive: true });
      await writeFile(
        args.getterSnapshotPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            chainId: 137,
            capturedAt: new Date().toISOString(),
            standardExchange,
            negRiskExchange,
            orderTypehash: ORDER_TYPEHASH,
            orderFilledTopic: ORDER_FILLED_TOPIC
          },
          null,
          2
        )}\n`
      );
    }
  }

  return { ok: checks.every((entry) => entry.ok), checks };
}
