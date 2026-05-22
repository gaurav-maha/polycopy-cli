import { createHmac } from "node:crypto";
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getCreate2Address,
  http,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { AssetType, Chain, ClobClient, SignatureTypeV2, type ApiKeyCreds } from "@polymarket/clob-client-v2";
import { applyPoly1271Wallet } from "../config/account-set.js";
import type { AccountConfig } from "../config/schema.js";
import {
  COLLATERAL_ONRAMP,
  CTF,
  CTF_EXCHANGE_V2,
  DEPOSIT_WALLET_FACTORY,
  NEG_RISK_CTF_EXCHANGE_V2,
  PUSD,
  USDC_E
} from "../constants/chain.js";
import { buildAccountSetupPlan, type AccountSetupPlan } from "./setup-plan.js";

const relayerUrl = "https://relayer-v2.polymarket.com";
const depositWalletImplementation = "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB" as const;
const depositWalletDomainName = "DepositWallet";
const depositWalletDomainVersion = "1";
const maxUint256 = 2n ** 256n - 1n;
const relayerAuthHelp =
  "provide RELAYER_API_KEY (and optional RELAYER_API_KEY_ADDRESS) or POLY_BUILDER_API_KEY/POLY_BUILDER_SECRET/POLY_BUILDER_PASS_PHRASE in the wallet file";

const erc1967Const1 = "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3" as const;
const erc1967Const2 = "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076" as const;
const erc1967Prefix = 0x61003d3d8160233d3973n;

export const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "allowance", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }
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

const depositWalletTypes = {
  Call: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" }
  ],
  Batch: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "calls", type: "Call[]" }
  ]
} as const;

export type DepositWalletCall = { target: string; value: string; data: string };

export type RelayerSubmission = {
  transactionID: string;
  state: string;
  transactionHash?: string;
};

export interface Poly1271Relayer {
  hasSubmitAuth(): boolean;
  isDepositWalletDeployed(walletAddress: string): Promise<boolean>;
  deployDepositWallet(owner: string): Promise<RelayerSubmission>;
  getWalletNonce(owner: string): Promise<string>;
  submitWalletBatch(args: {
    owner: string;
    walletAddress: string;
    nonce: string;
    deadline: string;
    calls: DepositWalletCall[];
    signature: string;
  }): Promise<RelayerSubmission>;
  waitForTransaction(transactionID: string): Promise<RelayerSubmission | undefined>;
}

export interface Poly1271ChainOps {
  readErc20Balance(token: string, owner: string): Promise<bigint>;
  readErc20Allowance(token: string, owner: string, spender: string): Promise<bigint>;
  readErc1155ApprovalForAll(token: string, owner: string, operator: string): Promise<boolean>;
  transferErc20(token: string, to: string, amountRaw: bigint): Promise<string>;
  approveErc20(token: string, spender: string, amountRaw: bigint): Promise<string>;
  wrapUsdcToPusd(to: string, amountRaw: bigint): Promise<string>;
  waitForTransaction(hash: string): Promise<void>;
}

export type Poly1271ExecutedAction = {
  id: string;
  transactionID?: string;
  txHash?: string;
  state?: string;
};

export type Poly1271SetupResult = {
  ok: boolean;
  plan: AccountSetupPlan;
  account: AccountConfig;
  executedActions: Poly1271ExecutedAction[];
  skippedActions: string[];
  errors: string[];
};

export type RelayerAuth =
  | { kind: "relayer"; apiKey: string; address: string }
  | { kind: "builder"; key: string; secret: string; passphrase: string };

export function deriveDepositWalletAddress(owner: string): `0x${string}` {
  const walletId = pad(getAddress(owner), { dir: "left", size: 32 });
  const args = encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }],
    [DEPOSIT_WALLET_FACTORY, walletId]
  );
  const salt = keccak256(args);
  const bytecodeHash = initCodeHashERC1967(depositWalletImplementation, args);
  return getCreate2Address({ from: DEPOSIT_WALLET_FACTORY, salt, bytecodeHash });
}

export async function executePoly1271Setup(args: {
  account: AccountConfig;
  copy: { enableSell: boolean };
  privateKey: Hex;
  rpcUrl?: string;
  targetCollateralRaw?: bigint;
  approveMax?: boolean;
  relayer?: Poly1271Relayer;
  chain?: Poly1271ChainOps;
  syncClob?: (account: AccountConfig) => Promise<void>;
  waitForRelayer?: boolean;
  nowMs?: number;
  deadlineSeconds?: number;
}): Promise<Poly1271SetupResult> {
  const signer = privateKeyToAccount(args.privateKey);
  const owner = getAddress(args.account.ownerSignerAddress ?? signer.address);
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("PRIVATE_KEY does not match configured ownerSignerAddress");
  }

  const depositWallet = getAddress(deriveDepositWalletAddress(owner));
  const account = applyPoly1271Wallet(args.account, { owner, contract: depositWallet });
  const plan = buildAccountSetupPlan({
    account,
    copy: args.copy,
    execute: true,
    targetCollateralRaw: args.targetCollateralRaw
  });
  plan.sendsTransactions = true;

  const relayer = args.relayer ?? createHttpPoly1271Relayer({ auth: undefined });
  const chain = args.chain ?? createViemPoly1271ChainOps({ privateKey: args.privateKey, rpcUrl: requireRpcUrl(args.rpcUrl) });
  const executedActions: Poly1271ExecutedAction[] = [];
  const skippedActions: string[] = [];
  const errors: string[] = [];

  const targetCollateralRaw = args.targetCollateralRaw ?? 0n;
  if (targetCollateralRaw > 0n) {
    const funding = await preflightFundingSufficiency({ chain, owner, depositWallet, targetCollateralRaw });
    if (!funding.ok) {
      return failResult({ plan, account, executedActions, skippedActions, errors }, funding.error);
    }
  }

  const deployed = await relayer.isDepositWalletDeployed(depositWallet);
  if (!deployed) {
    if (!relayer.hasSubmitAuth()) {
      return failResult(
        { plan, account, executedActions, skippedActions, errors },
        `setup-account POLY_1271 requires relayer auth to deploy the deposit wallet; ${relayerAuthHelp}`
      );
    }
    const deployedTx = await relayer.deployDepositWallet(owner);
    executedActions.push({ id: "deploy.deposit-wallet", transactionID: deployedTx.transactionID, state: deployedTx.state });
    if (args.waitForRelayer !== false) {
      const mined = await relayer.waitForTransaction(deployedTx.transactionID);
      if (!mined || mined.state === "STATE_FAILED" || mined.state === "STATE_INVALID") {
        return failResult({ plan, account, executedActions, skippedActions, errors }, "deposit wallet deployment did not confirm");
      }
    }
  } else {
    skippedActions.push("deploy.deposit-wallet");
  }

  const approvalAmount = args.approveMax === true || targetCollateralRaw === 0n ? maxUint256 : targetCollateralRaw;
  const calls = await buildApprovalCalls({
    chain,
    depositWallet,
    approvalAmount,
    enableSell: args.copy.enableSell
  });
  if (calls.length > 0) {
    if (!relayer.hasSubmitAuth()) {
      return failResult(
        { plan, account, executedActions, skippedActions, errors },
        `setup-account POLY_1271 requires relayer auth to submit deposit wallet approvals; ${relayerAuthHelp}`
      );
    }
  }

  if (targetCollateralRaw > 0n) {
    const funded = await fundDepositWallet({ chain, owner, depositWallet, targetCollateralRaw, executedActions, skippedActions });
    if (!funded.ok) {
      return failResult({ plan, account, executedActions, skippedActions, errors }, funded.error);
    }
  }

  if (calls.length > 0) {
    const nonce = await relayer.getWalletNonce(owner);
    const deadline = String(Math.floor((args.nowMs ?? Date.now()) / 1000) + (args.deadlineSeconds ?? 1200));
    const signature = await signDepositWalletBatch({
      privateKey: args.privateKey,
      walletAddress: depositWallet,
      nonce,
      deadline,
      calls
    });
    const batchTx = await relayer.submitWalletBatch({ owner, walletAddress: depositWallet, nonce, deadline, calls, signature });
    executedActions.push({ id: "approve.deposit-wallet.batch", transactionID: batchTx.transactionID, state: batchTx.state });
    if (args.waitForRelayer !== false) {
      const mined = await relayer.waitForTransaction(batchTx.transactionID);
      if (!mined || mined.state === "STATE_FAILED" || mined.state === "STATE_INVALID") {
        return failResult({ plan, account, executedActions, skippedActions, errors }, "deposit wallet approval batch did not confirm");
      }
    }
  } else {
    skippedActions.push("approve.deposit-wallet.batch");
  }

  if (args.syncClob) {
    await args.syncClob(account);
    executedActions.push({ id: "sync.clob.cache" });
  } else {
    skippedActions.push("sync.clob.cache");
  }

  return { ok: errors.length === 0, plan, account, executedActions, skippedActions, errors };
}

export function createHttpPoly1271Relayer(args: {
  auth?: RelayerAuth;
  url?: string;
  fetchFn?: typeof fetch;
}): Poly1271Relayer {
  const url = (args.url ?? relayerUrl).replace(/\/$/, "");
  const fetchFn = args.fetchFn ?? fetch;
  const auth = args.auth;

  return {
    hasSubmitAuth: () => auth !== undefined,
    async isDepositWalletDeployed(walletAddress: string): Promise<boolean> {
      const response = await requestJson<{ deployed?: boolean }>(
        fetchFn,
        `${url}/deployed?address=${encodeURIComponent(walletAddress)}&type=WALLET`,
        { method: "GET" }
      );
      return response.deployed === true;
    },
    async deployDepositWallet(owner: string): Promise<RelayerSubmission> {
      return submit({ type: "WALLET-CREATE", from: owner, to: DEPOSIT_WALLET_FACTORY });
    },
    async getWalletNonce(owner: string): Promise<string> {
      const response = await requestJson<{ nonce?: string }>(
        fetchFn,
        `${url}/nonce?address=${encodeURIComponent(owner)}&type=WALLET`,
        { method: "GET", headers: authHeaders(auth, "GET", "/nonce") }
      );
      if (!response.nonce) throw new Error("relayer nonce response missing nonce");
      return response.nonce;
    },
    async submitWalletBatch(batch): Promise<RelayerSubmission> {
      return submit({
        type: "WALLET",
        from: batch.owner,
        to: DEPOSIT_WALLET_FACTORY,
        nonce: batch.nonce,
        signature: batch.signature,
        depositWalletParams: {
          depositWallet: batch.walletAddress,
          deadline: batch.deadline,
          calls: batch.calls
        }
      });
    },
    async waitForTransaction(transactionID: string): Promise<RelayerSubmission | undefined> {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = await requestJson<RelayerSubmission[]>(
          fetchFn,
          `${url}/transaction?id=${encodeURIComponent(transactionID)}`,
          { method: "GET", headers: authHeaders(auth, "GET", "/transaction") }
        );
        const row = rows[0];
        if (row && (row.state === "STATE_CONFIRMED" || row.state === "STATE_FAILED" || row.state === "STATE_INVALID")) {
          return row;
        }
        await sleep(2_000);
      }
      return undefined;
    }
  };

  async function submit(payload: unknown): Promise<RelayerSubmission> {
    const body = JSON.stringify(payload);
    return requestJson<RelayerSubmission>(fetchFn, `${url}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(auth, "POST", "/submit", body) },
      body
    });
  }
}

export async function syncPoly1271ClobBalance(args: {
  privateKey: Hex;
  rpcUrl: string;
  creds: ApiKeyCreds;
  funder: string;
}): Promise<void> {
  const account = privateKeyToAccount(args.privateKey);
  const signer = createWalletClient({ account, chain: polygon, transport: http(args.rpcUrl) });
  const client = new ClobClient({
    host: "https://clob.polymarket.com",
    chain: Chain.POLYGON,
    signer: signer as never,
    creds: args.creds,
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: args.funder
  });
  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
}

function createViemPoly1271ChainOps(args: { privateKey: Hex; rpcUrl: string }): Poly1271ChainOps {
  const account = privateKeyToAccount(args.privateKey);
  const publicClient = createPublicClient({ chain: polygon, transport: http(args.rpcUrl) });
  const walletClient = createWalletClient({ account, chain: polygon, transport: http(args.rpcUrl) });

  return {
    async readErc20Balance(token, owner) {
      return publicClient.readContract({
        address: token as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner as Address]
      });
    },
    async readErc20Allowance(token, owner, spender) {
      return publicClient.readContract({
        address: token as Address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner as Address, spender as Address]
      });
    },
    async readErc1155ApprovalForAll(token, owner, operator) {
      return publicClient.readContract({
        address: token as Address,
        abi: erc1155Abi,
        functionName: "isApprovedForAll",
        args: [owner as Address, operator as Address]
      });
    },
    async transferErc20(token, to, amountRaw) {
      return walletClient.writeContract({
        address: token as Address,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to as Address, amountRaw]
      });
    },
    async approveErc20(token, spender, amountRaw) {
      return walletClient.writeContract({
        address: token as Address,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender as Address, amountRaw]
      });
    },
    async wrapUsdcToPusd(to, amountRaw) {
      return walletClient.writeContract({
        address: COLLATERAL_ONRAMP,
        abi: onrampAbi,
        functionName: "wrap",
        args: [USDC_E, to as Address, amountRaw]
      });
    },
    async waitForTransaction(hash) {
      await publicClient.waitForTransactionReceipt({ hash: hash as Hex });
    }
  };
}

async function fundDepositWallet(args: {
  chain: Poly1271ChainOps;
  owner: string;
  depositWallet: string;
  targetCollateralRaw: bigint;
  executedActions: Poly1271ExecutedAction[];
  skippedActions: string[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const currentDepositPusd = await args.chain.readErc20Balance(PUSD, args.depositWallet);
  let remaining = args.targetCollateralRaw > currentDepositPusd ? args.targetCollateralRaw - currentDepositPusd : 0n;
  if (remaining <= 0n) {
    args.skippedActions.push("fund.deposit-wallet");
    return { ok: true };
  }

  const ownerPusd = await args.chain.readErc20Balance(PUSD, args.owner);
  const ownerUsdc = await args.chain.readErc20Balance(USDC_E, args.owner);
  if (ownerPusd + ownerUsdc < remaining) {
    return {
      ok: false,
      error: `insufficient owner pUSD/USDC.e to fund deposit wallet target: missingRaw=${(remaining - ownerPusd - ownerUsdc).toString()}`
    };
  }

  const transferAmount = ownerPusd < remaining ? ownerPusd : remaining;
  if (transferAmount > 0n) {
    const hash = await args.chain.transferErc20(PUSD, args.depositWallet, transferAmount);
    await args.chain.waitForTransaction(hash);
    args.executedActions.push({ id: "transfer.pusd.to.deposit-wallet", txHash: hash });
    remaining -= transferAmount;
  }

  if (remaining <= 0n) return { ok: true };

  const usdcAllowance = await args.chain.readErc20Allowance(USDC_E, args.owner, COLLATERAL_ONRAMP);
  if (usdcAllowance < remaining) {
    const approveHash = await args.chain.approveErc20(USDC_E, COLLATERAL_ONRAMP, remaining);
    await args.chain.waitForTransaction(approveHash);
    args.executedActions.push({ id: "approve.usdc.e.collateral-onramp", txHash: approveHash });
  } else {
    args.skippedActions.push("approve.usdc.e.collateral-onramp");
  }

  const wrapHash = await args.chain.wrapUsdcToPusd(args.depositWallet, remaining);
  await args.chain.waitForTransaction(wrapHash);
  args.executedActions.push({ id: "wrap.usdc.e.to.deposit-wallet-pusd", txHash: wrapHash });
  return { ok: true };
}

async function preflightFundingSufficiency(args: {
  chain: Poly1271ChainOps;
  owner: string;
  depositWallet: string;
  targetCollateralRaw: bigint;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const currentDepositPusd = await args.chain.readErc20Balance(PUSD, args.depositWallet);
  const remaining = args.targetCollateralRaw > currentDepositPusd ? args.targetCollateralRaw - currentDepositPusd : 0n;
  if (remaining <= 0n) return { ok: true };

  const [ownerPusd, ownerUsdc] = await Promise.all([
    args.chain.readErc20Balance(PUSD, args.owner),
    args.chain.readErc20Balance(USDC_E, args.owner)
  ]);
  if (ownerPusd + ownerUsdc < remaining) {
    return {
      ok: false,
      error: `insufficient owner pUSD/USDC.e to fund deposit wallet target: missingRaw=${(remaining - ownerPusd - ownerUsdc).toString()}`
    };
  }
  return { ok: true };
}

async function buildApprovalCalls(args: {
  chain: Poly1271ChainOps;
  depositWallet: string;
  approvalAmount: bigint;
  enableSell: boolean;
}): Promise<DepositWalletCall[]> {
  const calls: DepositWalletCall[] = [];
  for (const spender of [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2] as const) {
    const allowance = await args.chain.readErc20Allowance(PUSD, args.depositWallet, spender);
    if (allowance < args.approvalAmount) {
      calls.push({
        target: PUSD,
        value: "0",
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, args.approvalAmount] })
      });
    }
  }

  if (args.enableSell) {
    for (const operator of [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2] as const) {
      const approved = await args.chain.readErc1155ApprovalForAll(CTF, args.depositWallet, operator);
      if (!approved) {
        calls.push({
          target: CTF,
          value: "0",
          data: encodeFunctionData({ abi: erc1155Abi, functionName: "setApprovalForAll", args: [operator, true] })
        });
      }
    }
  }

  return calls;
}

async function signDepositWalletBatch(args: {
  privateKey: Hex;
  walletAddress: string;
  nonce: string;
  deadline: string;
  calls: DepositWalletCall[];
}): Promise<Hex> {
  const account = privateKeyToAccount(args.privateKey);
  const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
  return walletClient.signTypedData({
    account,
    domain: {
      name: depositWalletDomainName,
      version: depositWalletDomainVersion,
      chainId: 137,
      verifyingContract: args.walletAddress as Address
    },
    types: depositWalletTypes,
    primaryType: "Batch",
    message: {
      wallet: args.walletAddress as Address,
      nonce: BigInt(args.nonce),
      deadline: BigInt(args.deadline),
      calls: args.calls.map((call) => ({
        target: call.target as Address,
        value: BigInt(call.value),
        data: call.data as Hex
      }))
    }
  });
}

function failResult(
  result: Omit<Poly1271SetupResult, "ok">,
  error: string
): Poly1271SetupResult {
  result.errors.push(error);
  return { ...result, ok: false };
}

function initCodeHashERC1967(implementation: Hex, args: Hex): Hex {
  const n = BigInt((args.length - 2) / 2);
  const combined = erc1967Prefix + (n << 56n);
  return keccak256(
    concat([
      toHex(combined, { size: 10 }),
      implementation,
      "0x6009",
      erc1967Const2,
      erc1967Const1,
      args
    ])
  );
}

function requireRpcUrl(rpcUrl: string | undefined): string {
  if (!rpcUrl) throw new Error("setup-account POLY_1271 --execute requires rpc primary url");
  return rpcUrl;
}

async function requestJson<T>(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<T> {
  const response = await fetchFn(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`relayer HTTP ${response.status}: ${body}`);
  }
  return (body ? JSON.parse(body) : {}) as T;
}

function authHeaders(auth: RelayerAuth | undefined, method: string, path: string, body?: string): Record<string, string> {
  if (!auth) return {};
  if (auth.kind === "relayer") {
    return {
      RELAYER_API_KEY: auth.apiKey,
      RELAYER_API_KEY_ADDRESS: auth.address
    };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  return {
    POLY_BUILDER_API_KEY: auth.key,
    POLY_BUILDER_TIMESTAMP: String(timestamp),
    POLY_BUILDER_PASSPHRASE: auth.passphrase,
    POLY_BUILDER_SIGNATURE: buildBuilderHmacSignature(auth.secret, timestamp, method, path, body)
  };
}

function buildBuilderHmacSignature(secret: string, timestamp: number, method: string, path: string, body?: string): string {
  const message = `${timestamp}${method}${path}${body ?? ""}`;
  const hmac = createHmac("sha256", Buffer.from(secret, "base64"));
  return hmac.update(message).digest("base64").replaceAll("+", "-").replaceAll("/", "_");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
