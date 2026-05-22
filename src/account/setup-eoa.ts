import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ClobClient } from "@polymarket/clob-client-v2";
import {
  COLLATERAL_ONRAMP,
  CTF,
  CTF_EXCHANGE_V2,
  NEG_RISK_CTF_EXCHANGE_V2,
  PUSD,
  USDC_E
} from "../constants/chain.js";
import type { AccountConfig } from "../config/schema.js";
import type { AccountSetupPlan } from "./setup-plan.js";
import { buildAccountSetupPlan } from "./setup-plan.js";

const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "allowance", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }
] as const;

const onrampAbi = [
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
] as const;

const erc1155Abi = [
  {
    type: "function",
    name: "isApprovedForAll",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "setApprovalForAll",
    inputs: [{ type: "address" }, { type: "bool" }],
    outputs: [],
    stateMutability: "nonpayable"
  }
] as const;

export type SetupExecuteResult = {
  ok: boolean;
  plan: AccountSetupPlan;
  executedActions: string[];
  skippedActions: string[];
  errors: string[];
};

function parsePrivateKey(raw: string): Hex {
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex value loaded from explicit .env");
  }
  return normalized as Hex;
}

async function loadExplicitPrivateKey(envFile = ".env"): Promise<Hex> {
  const envPath = resolve(envFile);
  let envContents = "";
  try {
    envContents = await readFile(envPath, "utf8");
  } catch {
    throw new Error("setup-account --execute requires PRIVATE_KEY in explicit .env file");
  }
  const match = envContents.match(/^PRIVATE_KEY=(.+)$/m);
  if (!match?.[1]?.trim()) {
    throw new Error("setup-account --execute requires PRIVATE_KEY in explicit .env file");
  }
  return parsePrivateKey(match[1].trim());
}

export async function executeEoaSetup(args: {
  account: AccountConfig;
  copy: { enableSell: boolean };
  rpcUrl: string;
  wrapAmountRaw?: bigint;
  targetCollateralRaw?: bigint;
  approveMax?: boolean;
  envFile?: string;
}): Promise<SetupExecuteResult> {
  const plan = buildAccountSetupPlan({
    account: args.account,
    copy: args.copy,
    execute: true,
    targetCollateralRaw: args.targetCollateralRaw
  });
  plan.mode = "execute";
  plan.sendsTransactions = true;
  for (const action of plan.actions) {
    (action as { sendsTransaction: boolean }).sendsTransaction = action.method !== "fund" && action.method !== "syncClobCache";
  }

  const privateKey = await loadExplicitPrivateKey(args.envFile ?? ".env");
  const account = privateKeyToAccount(privateKey);
  const owner = args.account.ownerSignerAddress as Address;
  if (account.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("PRIVATE_KEY does not match configured ownerSignerAddress");
  }

  const publicClient = createPublicClient({ chain: polygon, transport: http(args.rpcUrl) });
  const client = createWalletClient({ account, chain: polygon, transport: http(args.rpcUrl) });
  const executedActions: string[] = [];
  const skippedActions: string[] = [];
  const errors: string[] = [];

  const targetCollateral = args.targetCollateralRaw ?? args.wrapAmountRaw ?? 0n;
  const pusdBalance = (await publicClient.readContract({
    address: PUSD,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [args.account.funderAddress as Address]
  })) as bigint;
  const usdcBalance = (await publicClient.readContract({
    address: USDC_E,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [args.account.funderAddress as Address]
  })) as bigint;
  const wrapAmount =
    args.wrapAmountRaw ??
    (targetCollateral > 0n && pusdBalance < targetCollateral ? targetCollateral - pusdBalance : 0n);
  if (wrapAmount > usdcBalance) {
    errors.push("insufficient USDC.e to wrap target pUSD collateral");
    return { ok: false, plan, executedActions, skippedActions, errors };
  }
  const usdcAllowance = (await publicClient.readContract({
    address: USDC_E,
    abi: erc20Abi,
    functionName: "allowance",
    args: [args.account.funderAddress as Address, COLLATERAL_ONRAMP]
  })) as bigint;
  if (usdcAllowance < wrapAmount && wrapAmount > 0n) {
    const hash = await client.writeContract({
      address: USDC_E,
      abi: erc20Abi,
      functionName: "approve",
      args: [COLLATERAL_ONRAMP, wrapAmount]
    });
    executedActions.push(`approve.usdc.e.collateral-onramp:${hash}`);
  } else {
    skippedActions.push("approve.usdc.e.collateral-onramp");
  }

  if (wrapAmount > 0n) {
    const hash = await client.writeContract({
      address: COLLATERAL_ONRAMP,
      abi: onrampAbi,
      functionName: "wrap",
      args: [USDC_E, args.account.funderAddress as Address, wrapAmount]
    });
    executedActions.push(`wrap.usdc.e.to.pusd:${hash}`);
  } else {
    skippedActions.push("wrap.usdc.e.to.pusd");
  }

  for (const [actionId, token, spender] of [
    ["approve.pusd.ctf-exchange-v2", PUSD, CTF_EXCHANGE_V2],
    ["approve.pusd.neg-risk-ctf-exchange-v2", PUSD, NEG_RISK_CTF_EXCHANGE_V2]
  ] as const) {
    const allowance = (await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [args.account.orderMakerAddress as Address, spender]
    })) as bigint;
    const approvalAmount = args.approveMax || targetCollateral === 0n ? 2n ** 256n - 1n : targetCollateral;
    if (allowance < approvalAmount) {
      const hash = await client.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, approvalAmount]
      });
      executedActions.push(`${actionId}:${hash}`);
    } else {
      skippedActions.push(actionId);
    }
  }

  if (args.copy.enableSell) {
    for (const [actionId, operator] of [
      ["approve.erc1155.ctf-exchange-v2", CTF_EXCHANGE_V2],
      ["approve.erc1155.neg-risk-ctf-exchange-v2", NEG_RISK_CTF_EXCHANGE_V2]
    ] as const) {
      const approved = (await publicClient.readContract({
        address: CTF,
        abi: erc1155Abi,
        functionName: "isApprovedForAll",
        args: [args.account.orderMakerAddress as Address, operator]
      })) as boolean;
      if (!approved) {
        const hash = await client.writeContract({
          address: CTF,
          abi: erc1155Abi,
          functionName: "setApprovalForAll",
          args: [operator, true]
        });
        executedActions.push(`${actionId}:${hash}`);
      } else {
        skippedActions.push(actionId);
      }
    }
  }

  try {
    const clob = new ClobClient({ host: "https://clob.polymarket.com", chain: 137, signatureType: args.account.signatureType });
    void clob;
    executedActions.push("sync.clob.cache");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return { ok: errors.length === 0, plan, executedActions, skippedActions, errors };
}
