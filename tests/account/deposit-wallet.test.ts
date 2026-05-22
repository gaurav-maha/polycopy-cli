import { encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { COLLATERAL_ONRAMP, CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2, PUSD, USDC_E } from "../../src/constants/chain.js";
import {
  deriveDepositWalletAddress,
  executePoly1271Setup,
  erc20Abi,
  type Poly1271ChainOps,
  type Poly1271Relayer
} from "../../src/account/setup-poly1271.js";

const privateKey = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const owner = privateKeyToAccount(privateKey).address;
const depositWallet = deriveDepositWalletAddress(owner);

describe("POLY_1271 deposit wallet setup", () => {
  it("derives the same deterministic deposit wallet address as Polymarket's relayer client", () => {
    expect(deriveDepositWalletAddress("0x1111111111111111111111111111111111111111")).toBe(
      "0xfAeA0f08159fcF2f573fE24E9E989B0d48f7651B"
    );
  });

  it("deploys, funds, approves, syncs, and returns the persisted POLY_1271 account", async () => {
    const relayer = new RecordingRelayer(false);
    const chain = new RecordingChain({
      ownerPusdRaw: 10_000_000n,
      depositPusdRaw: 0n,
      ownerUsdcRaw: 0n,
      allowances: new Map([
        [allowanceKey(depositWallet, CTF_EXCHANGE_V2), 0n],
        [allowanceKey(depositWallet, NEG_RISK_CTF_EXCHANGE_V2), 0n]
      ])
    });

    const result = await executePoly1271Setup({
      account: {
        walletMode: "EOA",
        signatureType: 0,
        ownerSignerAddress: owner,
        orderMakerAddress: owner,
        orderSignerAddress: owner,
        funderAddress: owner
      },
      copy: { enableSell: false },
      privateKey,
      targetCollateralRaw: 5_000_000n,
      approveMax: false,
      relayer,
      chain,
      syncClob: async () => {
        chain.synced = true;
      },
      waitForRelayer: true,
      nowMs: 1_779_408_000_000
    });

    expect(result.ok).toBe(true);
    expect(result.account).toEqual({
      walletMode: "POLY_1271",
      signatureType: 3,
      ownerSignerAddress: owner,
      orderMakerAddress: depositWallet,
      orderSignerAddress: depositWallet,
      funderAddress: depositWallet
    });
    expect(result.executedActions.map((action) => action.id)).toEqual([
      "deploy.deposit-wallet",
      "transfer.pusd.to.deposit-wallet",
      "approve.deposit-wallet.batch",
      "sync.clob.cache"
    ]);
    expect(chain.transfers).toEqual([{ token: PUSD, to: depositWallet, amountRaw: 5_000_000n }]);
    expect(relayer.deploys).toEqual([{ owner }]);
    expect(relayer.batches).toHaveLength(1);
    expect(relayer.batches[0]).toMatchObject({
      owner,
      walletAddress: depositWallet,
      nonce: "7",
      deadline: String(Math.floor(1_779_408_000_000 / 1000) + 1200)
    });
    expect(relayer.batches[0]!.calls.map((call) => call.target)).toEqual([PUSD, PUSD]);
    expect(relayer.batches[0]!.calls.map((call) => call.data)).toEqual([
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [CTF_EXCHANGE_V2, 5_000_000n]
      }),
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [NEG_RISK_CTF_EXCHANGE_V2, 5_000_000n]
      })
    ]);
    expect(chain.synced).toBe(true);
  });

  it("always uses the owner's deterministic deposit wallet during execution", async () => {
    const staleConfiguredWallet = "0x3333333333333333333333333333333333333333";
    const relayer = new RecordingRelayer(true);
    const chain = new RecordingChain({
      ownerPusdRaw: 5_000_000n,
      depositPusdRaw: 0n,
      ownerUsdcRaw: 0n,
      allowances: new Map([
        [allowanceKey(depositWallet, CTF_EXCHANGE_V2), 5_000_000n],
        [allowanceKey(depositWallet, NEG_RISK_CTF_EXCHANGE_V2), 5_000_000n]
      ])
    });

    const result = await executePoly1271Setup({
      account: {
        walletMode: "POLY_1271",
        signatureType: 3,
        ownerSignerAddress: owner,
        orderMakerAddress: staleConfiguredWallet,
        orderSignerAddress: staleConfiguredWallet,
        funderAddress: staleConfiguredWallet
      },
      copy: { enableSell: false },
      privateKey,
      targetCollateralRaw: 5_000_000n,
      relayer,
      chain,
      waitForRelayer: true
    });

    expect(result.ok).toBe(true);
    expect(result.account.orderMakerAddress).toBe(depositWallet);
    expect(result.account.orderSignerAddress).toBe(depositWallet);
    expect(result.account.funderAddress).toBe(depositWallet);
    expect(chain.transfers).toEqual([{ token: PUSD, to: depositWallet, amountRaw: 5_000_000n }]);
  });

  it("fails before relayer submission when auth is missing and deployment or approvals are needed", async () => {
    const relayer = new RecordingRelayer(false, false);
    const chain = new RecordingChain({ ownerPusdRaw: 0n, depositPusdRaw: 0n, ownerUsdcRaw: 0n });

    const result = await executePoly1271Setup({
      account: {
        walletMode: "EOA",
        signatureType: 0,
        ownerSignerAddress: owner,
        orderMakerAddress: owner,
        orderSignerAddress: owner,
        funderAddress: owner
      },
      copy: { enableSell: false },
      privateKey,
      targetCollateralRaw: 0n,
      relayer,
      chain,
      syncClob: async () => {},
      waitForRelayer: true
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/relayer auth/i);
    expect(result.errors.join("\n")).toMatch(/RELAYER_API_KEY/);
    expect(result.errors.join("\n")).toMatch(/POLY_BUILDER_API_KEY/);
    expect(relayer.deploys).toEqual([]);
    expect(relayer.batches).toEqual([]);
  });

  it("fails before funding when approvals need relayer auth", async () => {
    const relayer = new RecordingRelayer(true, false);
    const chain = new RecordingChain({
      ownerPusdRaw: 5_000_000n,
      depositPusdRaw: 0n,
      ownerUsdcRaw: 0n,
      allowances: new Map([
        [allowanceKey(depositWallet, CTF_EXCHANGE_V2), 0n],
        [allowanceKey(depositWallet, NEG_RISK_CTF_EXCHANGE_V2), 0n]
      ])
    });

    const result = await executePoly1271Setup({
      account: {
        walletMode: "POLY_1271",
        signatureType: 3,
        ownerSignerAddress: owner,
        orderMakerAddress: depositWallet,
        orderSignerAddress: depositWallet,
        funderAddress: depositWallet
      },
      copy: { enableSell: false },
      privateKey,
      targetCollateralRaw: 5_000_000n,
      relayer,
      chain,
      waitForRelayer: true
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/relayer auth/i);
    expect(result.errors.join("\n")).toMatch(/RELAYER_API_KEY/);
    expect(result.errors.join("\n")).toMatch(/POLY_BUILDER_API_KEY/);
    expect(chain.transfers).toEqual([]);
    expect(chain.wraps).toEqual([]);
    expect(relayer.batches).toEqual([]);
  });

  it("funds remaining target by wrapping owner USDC.e after owner pUSD", async () => {
    const relayer = new RecordingRelayer(true);
    const chain = new RecordingChain({
      ownerPusdRaw: 2_000_000n,
      depositPusdRaw: 0n,
      ownerUsdcRaw: 3_000_000n,
      allowances: new Map([
        [allowanceKey(depositWallet, CTF_EXCHANGE_V2), 5_000_000n],
        [allowanceKey(depositWallet, NEG_RISK_CTF_EXCHANGE_V2), 5_000_000n],
        [allowanceKey(owner, COLLATERAL_ONRAMP), 0n]
      ])
    });

    const result = await executePoly1271Setup({
      account: {
        walletMode: "POLY_1271",
        signatureType: 3,
        ownerSignerAddress: owner,
        orderMakerAddress: depositWallet,
        orderSignerAddress: depositWallet,
        funderAddress: depositWallet
      },
      copy: { enableSell: false },
      privateKey,
      targetCollateralRaw: 5_000_000n,
      relayer,
      chain,
      waitForRelayer: true
    });

    expect(result.ok).toBe(true);
    expect(chain.transfers).toEqual([{ token: PUSD, to: depositWallet, amountRaw: 2_000_000n }]);
    expect(chain.approvals).toEqual([{ token: USDC_E, spender: COLLATERAL_ONRAMP, amountRaw: 3_000_000n }]);
    expect(chain.wraps).toEqual([{ to: depositWallet, amountRaw: 3_000_000n }]);
    expect(relayer.batches).toEqual([]);
  });

  it("does not transfer partial owner pUSD when total pUSD and USDC.e cannot fund the target", async () => {
    const relayer = new RecordingRelayer(false);
    const chain = new RecordingChain({
      ownerPusdRaw: 2_000_000n,
      depositPusdRaw: 0n,
      ownerUsdcRaw: 1_000_000n,
      allowances: new Map([
        [allowanceKey(depositWallet, CTF_EXCHANGE_V2), 5_000_000n],
        [allowanceKey(depositWallet, NEG_RISK_CTF_EXCHANGE_V2), 5_000_000n]
      ])
    });

    const result = await executePoly1271Setup({
      account: {
        walletMode: "POLY_1271",
        signatureType: 3,
        ownerSignerAddress: owner,
        orderMakerAddress: depositWallet,
        orderSignerAddress: depositWallet,
        funderAddress: depositWallet
      },
      copy: { enableSell: false },
      privateKey,
      targetCollateralRaw: 5_000_000n,
      relayer,
      chain,
      waitForRelayer: true
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/insufficient owner pUSD\/USDC\.e/i);
    expect(relayer.deploys).toEqual([]);
    expect(chain.transfers).toEqual([]);
    expect(chain.approvals).toEqual([]);
    expect(chain.wraps).toEqual([]);
  });
});

class RecordingRelayer implements Poly1271Relayer {
  readonly deploys: Array<{ owner: string }> = [];
  readonly batches: Array<{
    owner: string;
    walletAddress: string;
    nonce: string;
    deadline: string;
    calls: Array<{ target: string; value: string; data: string }>;
  }> = [];

  constructor(
    private deployed: boolean,
    private auth = true
  ) {}

  hasSubmitAuth(): boolean {
    return this.auth;
  }

  async isDepositWalletDeployed(): Promise<boolean> {
    return this.deployed;
  }

  async deployDepositWallet(owner: string): Promise<{ transactionID: string; state: string }> {
    this.deploys.push({ owner });
    this.deployed = true;
    return { transactionID: "deploy-1", state: "STATE_NEW" };
  }

  async waitForTransaction(transactionID: string): Promise<{ transactionID: string; state: string }> {
    return { transactionID, state: "STATE_CONFIRMED" };
  }

  async getWalletNonce(): Promise<string> {
    return "7";
  }

  async submitWalletBatch(args: {
    owner: string;
    walletAddress: string;
    nonce: string;
    deadline: string;
    calls: Array<{ target: string; value: string; data: string }>;
    signature: string;
  }): Promise<{ transactionID: string; state: string }> {
    void args.signature;
    this.batches.push(args);
    return { transactionID: "batch-1", state: "STATE_NEW" };
  }
}

class RecordingChain implements Poly1271ChainOps {
  readonly allowances: Map<string, bigint>;
  readonly transfers: Array<{ token: string; to: string; amountRaw: bigint }> = [];
  readonly approvals: Array<{ token: string; spender: string; amountRaw: bigint }> = [];
  readonly wraps: Array<{ to: string; amountRaw: bigint }> = [];
  synced = false;

  constructor(
    private balances: {
      ownerPusdRaw: bigint;
      depositPusdRaw: bigint;
      ownerUsdcRaw: bigint;
      allowances?: Map<string, bigint>;
    }
  ) {
    this.allowances = balances.allowances ?? new Map();
  }

  async readErc20Balance(token: string, ownerAddress: string): Promise<bigint> {
    if (token === PUSD && ownerAddress.toLowerCase() === owner.toLowerCase()) return this.balances.ownerPusdRaw;
    if (token === PUSD && ownerAddress.toLowerCase() === depositWallet.toLowerCase()) return this.balances.depositPusdRaw;
    return this.balances.ownerUsdcRaw;
  }

  async readErc20Allowance(_token: string, ownerAddress: string, spender: string): Promise<bigint> {
    return this.allowances.get(allowanceKey(ownerAddress, spender)) ?? 0n;
  }

  async readErc1155ApprovalForAll(): Promise<boolean> {
    return true;
  }

  async transferErc20(token: string, to: string, amountRaw: bigint): Promise<string> {
    this.transfers.push({ token, to, amountRaw });
    if (token === PUSD) {
      this.balances.ownerPusdRaw -= amountRaw;
      this.balances.depositPusdRaw += amountRaw;
    }
    return "0xtransfer";
  }

  async approveErc20(token: string, spender: string, amountRaw: bigint): Promise<string> {
    this.approvals.push({ token, spender, amountRaw });
    this.allowances.set(allowanceKey(owner, spender), amountRaw);
    return "0xapprove";
  }

  async wrapUsdcToPusd(to: string, amountRaw: bigint): Promise<string> {
    this.wraps.push({ to, amountRaw });
    this.balances.ownerUsdcRaw -= amountRaw;
    this.balances.depositPusdRaw += amountRaw;
    return "0xwrap";
  }

  async waitForTransaction(): Promise<void> {}
}

function allowanceKey(ownerAddress: string, spender: string): string {
  return `${ownerAddress.toLowerCase()}:${spender.toLowerCase()}`;
}
