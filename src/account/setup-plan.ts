import {
  COLLATERAL_ONRAMP,
  CTF,
  CTF_EXCHANGE_V2,
  DEPOSIT_WALLET_FACTORY,
  NEG_RISK_CTF_EXCHANGE_V2,
  PUSD,
  USDC_E
} from "../constants/chain.js";
import type { AccountConfig } from "../config/schema.js";
import { validateAccountConfig } from "./invariants.js";
import { UnsupportedSetupExecutionError, unsupportedNonEoaExecuteReason } from "./setup-proxy-stub.js";

type CompleteAccountConfig = AccountConfig & {
  ownerSignerAddress: string;
  orderMakerAddress: string;
  orderSignerAddress: string;
  funderAddress: string;
};

export type SetupCheck = {
  id: string;
  kind: string;
  asset?: string;
  tokenAddress?: string;
  owner?: string;
  target?: string;
  spender?: string;
  operator?: string;
  expectedSpenders?: string[];
  expectedSignatureType?: AccountConfig["signatureType"];
  status: "planned";
};

export type SetupAction = {
  id: string;
  method: string;
  asset?: string;
  tokenAddress?: string;
  amountRaw?: string;
  spender?: string;
  operator?: string;
  target?: string;
  from?: string;
  args?: readonly unknown[];
  sendsTransaction: false;
};

export type AccountSetupPlan = {
  command: "setup-account";
  mode: "dry-run" | "execute";
  walletMode: AccountConfig["walletMode"];
  signatureType: AccountConfig["signatureType"];
  sendsTransactions: boolean;
  account: CompleteAccountConfig;
  copy: { enableSell: boolean };
  checks: SetupCheck[];
  actions: SetupAction[];
  targetCollateralRaw?: string;
  executeUnsupportedReason?: string;
};

export function assertSetupAccountExecutionSupported(account: AccountConfig): void {
  const reason = unsupportedNonEoaExecuteReason(account);
  if (reason) {
    throw new UnsupportedSetupExecutionError(reason);
  }
}

export function buildAccountSetupPlan(args: {
  account: AccountConfig;
  copy: { enableSell: boolean };
  execute: boolean;
  targetCollateralRaw?: bigint;
}): AccountSetupPlan {
  const account = resolveCompleteAccount(args.account);

  const funder = account.funderAddress;
  const maker = account.orderMakerAddress;
  const owner = account.ownerSignerAddress;
  const collateralSource = account.walletMode === "POLY_1271" ? owner : funder;
  const checks: SetupCheck[] = [
    {
      id: "account.invariants",
      kind: "account_invariants",
      owner,
      expectedSignatureType: account.signatureType,
      status: "planned"
    },
    ...(account.walletMode === "POLY_1271"
      ? [
          {
            id: "deposit-wallet.deployed",
            kind: "wallet_deployment",
            owner,
            target: funder,
            status: "planned" as const
          },
          {
            id: "owner.pusd.balance",
            kind: "erc20_balance",
            asset: "pUSD",
            tokenAddress: PUSD,
            owner,
            status: "planned" as const
          }
        ]
      : []),
    { id: "pol.gas.balance", kind: "native_balance", asset: "POL", owner, status: "planned" },
    { id: "usdc.e.balance", kind: "erc20_balance", asset: "USDC.e", tokenAddress: USDC_E, owner: collateralSource, status: "planned" },
    { id: "pusd.balance", kind: "erc20_balance", asset: "pUSD", tokenAddress: PUSD, owner: funder, status: "planned" },
    {
      id: "usdc.e.allowance.collateral-onramp",
      kind: "erc20_allowance",
      asset: "USDC.e",
      tokenAddress: USDC_E,
      owner: collateralSource,
      spender: COLLATERAL_ONRAMP,
      status: "planned"
    },
    {
      id: "pusd.allowance.ctf-exchange-v2",
      kind: "erc20_allowance",
      asset: "pUSD",
      tokenAddress: PUSD,
      owner: maker,
      spender: CTF_EXCHANGE_V2,
      status: "planned"
    },
    {
      id: "pusd.allowance.neg-risk-ctf-exchange-v2",
      kind: "erc20_allowance",
      asset: "pUSD",
      tokenAddress: PUSD,
      owner: maker,
      spender: NEG_RISK_CTF_EXCHANGE_V2,
      status: "planned"
    },
    {
      id: "clob.cache.pusd-balance-allowance",
      kind: "clob_cache",
      asset: "pUSD",
      owner: funder,
      expectedSpenders: [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2],
      expectedSignatureType: account.signatureType,
      status: "planned"
    }
  ];

  const actions: SetupAction[] = [
    { id: "fund.pol.gas", method: "fund", asset: "POL", from: owner, sendsTransaction: false },
    ...(account.walletMode === "POLY_1271"
      ? [
          {
            id: "deploy.deposit-wallet",
            method: "deployDepositWallet",
            target: DEPOSIT_WALLET_FACTORY,
            from: owner,
            args: [owner],
            sendsTransaction: false as const
          },
          {
            id: "transfer.pusd.to.deposit-wallet",
            method: "transfer",
            asset: "pUSD",
            tokenAddress: PUSD,
            target: PUSD,
            from: owner,
            args: [funder, "amount"],
            ...(args.targetCollateralRaw !== undefined ? { amountRaw: args.targetCollateralRaw.toString() } : {}),
            sendsTransaction: false as const
          }
        ]
      : []),
    { id: "fund.usdc.e", method: "fund", asset: "USDC.e", tokenAddress: USDC_E, from: collateralSource, sendsTransaction: false },
    {
      id: "wrap.usdc.e.to.pusd",
      method: "wrap",
      asset: "USDC.e",
      tokenAddress: USDC_E,
      target: COLLATERAL_ONRAMP,
      from: owner,
      args: [USDC_E, funder, "amount"],
      ...(args.targetCollateralRaw !== undefined ? { amountRaw: args.targetCollateralRaw.toString() } : {}),
      sendsTransaction: false
    },
    {
      id: "approve.usdc.e.collateral-onramp",
      method: "approve",
      asset: "USDC.e",
      tokenAddress: USDC_E,
      target: USDC_E,
      from: collateralSource,
      spender: COLLATERAL_ONRAMP,
      args: [COLLATERAL_ONRAMP, "amount"],
      ...(args.targetCollateralRaw !== undefined ? { amountRaw: args.targetCollateralRaw.toString() } : {}),
      sendsTransaction: false
    },
    {
      id: "approve.pusd.ctf-exchange-v2",
      method: "approve",
      asset: "pUSD",
      tokenAddress: PUSD,
      target: PUSD,
      from: maker,
      spender: CTF_EXCHANGE_V2,
      args: [CTF_EXCHANGE_V2, "amount"],
      ...(args.targetCollateralRaw !== undefined ? { amountRaw: args.targetCollateralRaw.toString() } : {}),
      sendsTransaction: false
    },
    {
      id: "approve.pusd.neg-risk-ctf-exchange-v2",
      method: "approve",
      asset: "pUSD",
      tokenAddress: PUSD,
      target: PUSD,
      from: maker,
      spender: NEG_RISK_CTF_EXCHANGE_V2,
      args: [NEG_RISK_CTF_EXCHANGE_V2, "amount"],
      ...(args.targetCollateralRaw !== undefined ? { amountRaw: args.targetCollateralRaw.toString() } : {}),
      sendsTransaction: false
    },
    { id: "sync.clob.cache", method: "syncClobCache", asset: "pUSD", from: funder, sendsTransaction: false }
  ];

  if (args.copy.enableSell) {
    checks.push(
      {
        id: "erc1155.approval.ctf-exchange-v2",
        kind: "erc1155_approval",
        owner: maker,
        operator: CTF_EXCHANGE_V2,
        status: "planned"
      },
      {
        id: "erc1155.approval.neg-risk-ctf-exchange-v2",
        kind: "erc1155_approval",
        owner: maker,
        operator: NEG_RISK_CTF_EXCHANGE_V2,
        status: "planned"
      }
    );
    actions.push(
      {
        id: "approve.erc1155.ctf-exchange-v2",
        method: "setApprovalForAll",
        target: CTF,
        from: maker,
        operator: CTF_EXCHANGE_V2,
        args: [CTF_EXCHANGE_V2, true],
        sendsTransaction: false
      },
      {
        id: "approve.erc1155.neg-risk-ctf-exchange-v2",
        method: "setApprovalForAll",
        target: CTF,
        from: maker,
        operator: NEG_RISK_CTF_EXCHANGE_V2,
        args: [NEG_RISK_CTF_EXCHANGE_V2, true],
        sendsTransaction: false
      }
    );
  }

  return {
    command: "setup-account",
    mode: args.execute ? "execute" : "dry-run",
    walletMode: account.walletMode,
    signatureType: account.signatureType,
    sendsTransactions: false,
    account,
    copy: { enableSell: args.copy.enableSell },
    checks,
    actions,
    ...(args.targetCollateralRaw !== undefined ? { targetCollateralRaw: args.targetCollateralRaw.toString() } : {}),
    ...(args.execute ? { executeUnsupportedReason: unsupportedNonEoaExecuteReason(account) ?? undefined } : {})
  };
}

function resolveCompleteAccount(account: AccountConfig): CompleteAccountConfig {
  const validation = validateAccountConfig(account);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }

  const requiredFields = [
    "ownerSignerAddress",
    "orderMakerAddress",
    "orderSignerAddress",
    "funderAddress"
  ] as const;
  const missingFields = requiredFields.filter((field) => !account[field]);
  if (missingFields.length > 0) {
    throw new Error(`setup-account requires account addresses: missing ${missingFields.join(", ")}`);
  }

  return account as CompleteAccountConfig;
}
