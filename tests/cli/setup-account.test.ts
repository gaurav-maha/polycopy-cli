import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { deriveDepositWalletAddress } from "../../src/account/setup-poly1271.js";
import { resolveRequestedSetupWalletMode, resolveSetupAccount } from "../../src/cli/commands/setup-account.js";
import { execaNode } from "../helpers/execa-node.js";

describe("setup-account CLI", () => {
  let dir: string;
  let envPath: string;
  let rpcPath: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-setup-"));
    envPath = join(dir, ".env");
    rpcPath = join(dir, "rpc.json");
    configPath = join(dir, "config.json");
    await writeFile(
      envPath,
      "PRIVATE_KEY=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
      { mode: 0o600 }
    );
    await execaNode(["--json", "rpc", "add", "https://polygon.example/rpc"], { rpcPath });
    await execaNode(["--json", "init"], { configPath });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prints a dry-run plan from the env wallet", async () => {
    const owner = privateKeyToAccount("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").address;
    const result = await execaNode(["--json", "setup-account", "--secrets", envPath], { configPath, rpcPath });
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.plan).toMatchObject({
      mode: "dry-run",
      sendsTransactions: false,
      walletMode: "POLY_1271",
      account: {
        ownerSignerAddress: owner,
        orderMakerAddress: deriveDepositWalletAddress(owner),
        orderSignerAddress: deriveDepositWalletAddress(owner),
        funderAddress: deriveDepositWalletAddress(owner)
      }
    });
    expect(payload.plan.checks.map((check: { id: string }) => check.id)).toContain("pusd.allowance.ctf-exchange-v2");
  });

  it("accepts a target usd collateral amount for setup planning", async () => {
    const result = await execaNode(["--json", "setup-account", "--secrets", envPath, "--usd", "10"], {
      configPath,
      rpcPath
    });
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.plan).toMatchObject({
      mode: "dry-run",
      sendsTransactions: false,
      targetCollateralRaw: "10000000"
    });
    expect(payload.plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "wrap.usdc.e.to.pusd",
          amountRaw: "10000000"
        }),
        expect.objectContaining({
          id: "approve.pusd.ctf-exchange-v2",
          amountRaw: "10000000"
        })
      ])
    );
  });

  it("remembers an explicit wallet file path for later commands", async () => {
    await execaNode(["--json", "setup-account", "--secrets", envPath], { configPath, rpcPath });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.runtime.secretsPath).toBe(envPath);
  });

  it("reports the exact missing wallet file path before setup", async () => {
    const missingPath = join(dir, "missing-wallet.env");

    const result = await execaNode(["--json", "setup-account", "--secrets", missingPath], {
      configPath,
      rpcPath,
      reject: false
    });

    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ ok: false, command: "setup-account", error: "ACCOUNT_SETUP_FAILED" });
    expect(payload.reason).toContain(missingPath);
    expect(payload.reason).toContain("PRIVATE_KEY");
  });

  it("derives the deterministic POLY_1271 deposit wallet during dry-run planning", async () => {
    const owner = privateKeyToAccount("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").address;
    const staleDepositWallet = "0x3333333333333333333333333333333333333333";
    const deterministicDepositWallet = deriveDepositWalletAddress(owner);
    await execaNode(
      ["--json", "config", "set", "--wallet-mode", "POLY_1271", "--owner", owner, "--deposit-wallet", staleDepositWallet],
      { configPath }
    );

    const result = await execaNode(["--json", "setup-account", "--secrets", envPath], { configPath, rpcPath });
    const payload = JSON.parse(result.stdout);

    expect(payload.ok).toBe(true);
    expect(payload.wallet).toBe(owner);
    expect(payload.plan).toMatchObject({
      mode: "dry-run",
      sendsTransactions: false,
      walletMode: "POLY_1271",
      signatureType: 3,
      account: {
        ownerSignerAddress: owner,
        orderMakerAddress: deterministicDepositWallet,
        orderSignerAddress: deterministicDepositWallet,
        funderAddress: deterministicDepositWallet
      }
    });
  });

  it("defaults setup-account to deposit-wallet setup while keeping EOA as an advanced override", () => {
    const ownerAccount = privateKeyToAccount("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const privateKeyAccount = {
      walletMode: "EOA" as const,
      signatureType: 0 as const,
      ownerSignerAddress: ownerAccount.address,
      orderMakerAddress: ownerAccount.address,
      orderSignerAddress: ownerAccount.address,
      funderAddress: ownerAccount.address
    };
    const staleDepositWallet = "0x3333333333333333333333333333333333333333";
    const configuredPoly1271Account = {
      walletMode: "POLY_1271" as const,
      signatureType: 3 as const,
      ownerSignerAddress: ownerAccount.address,
      orderMakerAddress: staleDepositWallet,
      orderSignerAddress: staleDepositWallet,
      funderAddress: staleDepositWallet
    };

    expect(resolveRequestedSetupWalletMode(undefined)).toBe("POLY_1271");
    expect(resolveSetupAccount(privateKeyAccount, privateKeyAccount, resolveRequestedSetupWalletMode(undefined))).toMatchObject({
      walletMode: "POLY_1271",
      signatureType: 3,
      ownerSignerAddress: ownerAccount.address,
      orderMakerAddress: deriveDepositWalletAddress(ownerAccount.address),
      orderSignerAddress: deriveDepositWalletAddress(ownerAccount.address),
      funderAddress: deriveDepositWalletAddress(ownerAccount.address)
    });
    expect(resolveSetupAccount(configuredPoly1271Account, privateKeyAccount, "EOA")).toEqual(privateKeyAccount);
    expect(resolveSetupAccount(configuredPoly1271Account, privateKeyAccount, "POLY_1271")).toMatchObject({
      walletMode: "POLY_1271",
      signatureType: 3,
      ownerSignerAddress: ownerAccount.address,
      orderMakerAddress: deriveDepositWalletAddress(ownerAccount.address),
      orderSignerAddress: deriveDepositWalletAddress(ownerAccount.address),
      funderAddress: deriveDepositWalletAddress(ownerAccount.address)
    });
  });

  it("rejects a configured POLY_1271 owner mismatch instead of switching owners", () => {
    const privateKeyAccount = privateKeyToAccount("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const configuredOwner = privateKeyToAccount("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").address;
    const privateKeyAccountConfig = {
      walletMode: "EOA" as const,
      signatureType: 0 as const,
      ownerSignerAddress: privateKeyAccount.address,
      orderMakerAddress: privateKeyAccount.address,
      orderSignerAddress: privateKeyAccount.address,
      funderAddress: privateKeyAccount.address
    };
    const configuredPoly1271Account = {
      walletMode: "POLY_1271" as const,
      signatureType: 3 as const,
      ownerSignerAddress: configuredOwner,
      orderMakerAddress: deriveDepositWalletAddress(configuredOwner),
      orderSignerAddress: deriveDepositWalletAddress(configuredOwner),
      funderAddress: deriveDepositWalletAddress(configuredOwner)
    };

    expect(() => resolveSetupAccount(configuredPoly1271Account, privateKeyAccountConfig, resolveRequestedSetupWalletMode(undefined))).toThrow(
      "PRIVATE_KEY does not match configured ownerSignerAddress"
    );
    expect(() => resolveSetupAccount(configuredPoly1271Account, privateKeyAccountConfig, "POLY_1271")).toThrow(
      "PRIVATE_KEY does not match configured ownerSignerAddress"
    );
  });

  it("does not remember a new secrets path when execute setup fails", async () => {
    const configuredPath = join(dir, "configured.env");
    const explicitPath = join(dir, "explicit.env");
    await writeFile(
      configuredPath,
      "PRIVATE_KEY=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
      { mode: 0o600 }
    );
    await writeFile(
      explicitPath,
      "PRIVATE_KEY=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
      { mode: 0o600 }
    );
    await execaNode(["--json", "setup-account", "--secrets", configuredPath], { configPath, rpcPath });

    const result = await execaNode(["--json", "setup-account", "--execute", "--secrets", explicitPath], {
      configPath,
      rpcPath,
      reject: false
    });

    expect(result.exitCode).not.toBe(0);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.runtime.secretsPath).toBe(configuredPath);
  });
});
