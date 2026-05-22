import {
  COLLATERAL_ONRAMP,
  CTF_EXCHANGE_V2,
  DEPOSIT_WALLET_FACTORY,
  NEG_RISK_CTF_EXCHANGE_V2,
  PUSD,
  USDC_E
} from "../../src/constants/chain.js";
import { buildAccountSetupPlan, assertSetupAccountExecutionSupported } from "../../src/account/setup-plan.js";

const eoa = "0x1111111111111111111111111111111111111111";
const proxy = "0x2222222222222222222222222222222222222222";
const contractWallet = "0x3333333333333333333333333333333333333333";

function eoaAccount() {
  return {
    walletMode: "EOA" as const,
    signatureType: 0 as const,
    ownerSignerAddress: eoa,
    orderMakerAddress: eoa,
    orderSignerAddress: eoa,
    funderAddress: eoa
  };
}

describe("account setup dry-run plan", () => {
  it("plans EOA buy-only checks without ERC-1155 SELL approvals", () => {
    const plan = buildAccountSetupPlan({
      account: eoaAccount(),
      copy: { enableSell: false },
      execute: false
    });

    expect(plan.sendsTransactions).toBe(false);
    expect(plan.mode).toBe("dry-run");
    expect(plan.checks.map((check) => check.id)).toEqual([
      "account.invariants",
      "pol.gas.balance",
      "usdc.e.balance",
      "pusd.balance",
      "usdc.e.allowance.collateral-onramp",
      "pusd.allowance.ctf-exchange-v2",
      "pusd.allowance.neg-risk-ctf-exchange-v2",
      "clob.cache.pusd-balance-allowance"
    ]);
    expect(plan.actions.map((action) => action.id)).toEqual([
      "fund.pol.gas",
      "fund.usdc.e",
      "wrap.usdc.e.to.pusd",
      "approve.usdc.e.collateral-onramp",
      "approve.pusd.ctf-exchange-v2",
      "approve.pusd.neg-risk-ctf-exchange-v2",
      "sync.clob.cache"
    ]);
    expect(plan.checks.some((check) => check.kind === "erc1155_approval")).toBe(false);
    expect(plan.actions.some((action) => action.method === "setApprovalForAll")).toBe(false);
  });

  it("plans ERC-1155 approval checks for both exchange types when sells are enabled", () => {
    const plan = buildAccountSetupPlan({
      account: eoaAccount(),
      copy: { enableSell: true },
      execute: false
    });

    expect(plan.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "erc1155.approval.ctf-exchange-v2",
          kind: "erc1155_approval",
          owner: eoa,
          operator: CTF_EXCHANGE_V2
        }),
        expect.objectContaining({
          id: "erc1155.approval.neg-risk-ctf-exchange-v2",
          kind: "erc1155_approval",
          owner: eoa,
          operator: NEG_RISK_CTF_EXCHANGE_V2
        })
      ])
    );
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "approve.erc1155.ctf-exchange-v2",
          method: "setApprovalForAll",
          operator: CTF_EXCHANGE_V2
        }),
        expect.objectContaining({
          id: "approve.erc1155.neg-risk-ctf-exchange-v2",
          method: "setApprovalForAll",
          operator: NEG_RISK_CTF_EXCHANGE_V2
        })
      ])
    );
  });

  it("documents exact EOA assets and spenders for dry-run requirements", () => {
    const plan = buildAccountSetupPlan({
      account: eoaAccount(),
      copy: { enableSell: false },
      execute: false
    });

    expect(plan.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "usdc.e.allowance.collateral-onramp",
          asset: "USDC.e",
          tokenAddress: USDC_E,
          owner: eoa,
          spender: COLLATERAL_ONRAMP
        }),
        expect.objectContaining({
          id: "pusd.allowance.ctf-exchange-v2",
          asset: "pUSD",
          tokenAddress: PUSD,
          owner: eoa,
          spender: CTF_EXCHANGE_V2
        }),
        expect.objectContaining({
          id: "pusd.allowance.neg-risk-ctf-exchange-v2",
          asset: "pUSD",
          tokenAddress: PUSD,
          owner: eoa,
          spender: NEG_RISK_CTF_EXCHANGE_V2
        })
      ])
    );
  });

  it("fails mismatched account invariants before planning checks", () => {
    expect(() =>
      buildAccountSetupPlan({
        account: {
          walletMode: "EOA",
          signatureType: 0,
          ownerSignerAddress: eoa,
          orderMakerAddress: proxy,
          orderSignerAddress: eoa,
          funderAddress: eoa
        },
        copy: { enableSell: false },
        execute: false
      })
    ).toThrow(/EOA mode requires all account addresses to match/);
  });

  it("supports POLY_1271 execution while keeping legacy POLY_PROXY unsupported", () => {
    const polyProxyAccount = {
      walletMode: "POLY_PROXY" as const,
      signatureType: 1 as const,
      ownerSignerAddress: eoa,
      orderMakerAddress: proxy,
      orderSignerAddress: eoa,
      funderAddress: proxy
    };
    const poly1271Account = {
      walletMode: "POLY_1271" as const,
      signatureType: 3 as const,
      ownerSignerAddress: eoa,
      orderMakerAddress: contractWallet,
      orderSignerAddress: contractWallet,
      funderAddress: contractWallet
    };

    expect(buildAccountSetupPlan({ account: polyProxyAccount, copy: { enableSell: false }, execute: false }).walletMode).toBe(
      "POLY_PROXY"
    );
    expect(buildAccountSetupPlan({ account: poly1271Account, copy: { enableSell: false }, execute: false }).walletMode).toBe(
      "POLY_1271"
    );
    expect(() => assertSetupAccountExecutionSupported(polyProxyAccount)).toThrow(/POLY_PROXY setup-account --execute is unsupported/);
    expect(() => assertSetupAccountExecutionSupported(poly1271Account)).not.toThrow();
  });

  it("plans POLY_1271 setup with owner funding and deposit-wallet trading approvals", () => {
    const poly1271Account = {
      walletMode: "POLY_1271" as const,
      signatureType: 3 as const,
      ownerSignerAddress: eoa,
      orderMakerAddress: contractWallet,
      orderSignerAddress: contractWallet,
      funderAddress: contractWallet
    };

    const plan = buildAccountSetupPlan({
      account: poly1271Account,
      copy: { enableSell: false },
      execute: false,
      targetCollateralRaw: 5_000_000n
    });

    expect(plan.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "deposit-wallet.deployed",
          kind: "wallet_deployment",
          owner: eoa,
          target: contractWallet
        }),
        expect.objectContaining({
          id: "usdc.e.balance",
          owner: eoa
        }),
        expect.objectContaining({
          id: "owner.pusd.balance",
          owner: eoa
        }),
        expect.objectContaining({
          id: "usdc.e.allowance.collateral-onramp",
          owner: eoa,
          spender: COLLATERAL_ONRAMP
        }),
        expect.objectContaining({
          id: "pusd.balance",
          owner: contractWallet
        }),
        expect.objectContaining({
          id: "pusd.allowance.ctf-exchange-v2",
          owner: contractWallet,
          spender: CTF_EXCHANGE_V2
        })
      ])
    );
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "deploy.deposit-wallet",
          method: "deployDepositWallet",
          target: DEPOSIT_WALLET_FACTORY,
          from: eoa
        }),
        expect.objectContaining({
          id: "transfer.pusd.to.deposit-wallet",
          method: "transfer",
          from: eoa,
          target: PUSD,
          amountRaw: "5000000"
        }),
        expect.objectContaining({
          id: "approve.usdc.e.collateral-onramp",
          from: eoa,
          spender: COLLATERAL_ONRAMP
        }),
        expect.objectContaining({
          id: "approve.pusd.ctf-exchange-v2",
          from: contractWallet,
          spender: CTF_EXCHANGE_V2,
          amountRaw: "5000000"
        })
      ])
    );
  });
});
