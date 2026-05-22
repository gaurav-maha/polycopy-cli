import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { execaNode } from "../helpers/execa-node.js";

describe("wallet CLI", () => {
  let dir: string;
  let configPath: string;
  let walletFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-wallet-"));
    configPath = join(dir, "config.json");
    walletFile = join(dir, "wallet.env");
    await execaNode(["--json", "init"], { configPath });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a new EOA wallet file and sets it as the configured wallet", async () => {
    const result = await execaNode(["--json", "wallet", "new", "--wallet-file", walletFile], { configPath });
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ ok: true, command: "wallet new", walletFile });
    expect(payload.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(result.stdout).not.toContain("PRIVATE_KEY");

    const mode = (await stat(walletFile)).mode & 0o777;
    expect(mode).toBe(0o600);
    const contents = await readFile(walletFile, "utf8");
    expect(contents).toMatch(/^PRIVATE_KEY=0x[a-fA-F0-9]{64}$/m);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.runtime.secretsPath).toBe(walletFile);
    expect(config.account).toMatchObject({
      walletMode: "EOA",
      signatureType: 0,
      ownerSignerAddress: payload.address,
      orderMakerAddress: payload.address,
      orderSignerAddress: payload.address,
      funderAddress: payload.address
    });
  });

  it("uses an existing wallet env file and persists the derived EOA account", async () => {
    const privateKey = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const address = privateKeyToAccount(privateKey).address;
    await writeFile(walletFile, `PRIVATE_KEY=${privateKey}\n`, { mode: 0o600 });

    const result = await execaNode(["--json", "wallet", "use", walletFile], { configPath });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: "wallet use", walletFile, address });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.runtime.secretsPath).toBe(walletFile);
    expect(config.account.ownerSignerAddress).toBe(address);
    expect(config.account.funderAddress).toBe(address);
  });

  it("keeps a configured POLY_1271 deposit wallet when changing the local owner key", async () => {
    const oldOwner = "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344";
    const depositWallet = "0x3333333333333333333333333333333333333333";
    const privateKey = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const address = privateKeyToAccount(privateKey).address;
    await execaNode(
      ["--json", "config", "set", "--wallet-mode", "POLY_1271", "--owner", oldOwner, "--deposit-wallet", depositWallet],
      { configPath }
    );
    await writeFile(walletFile, `PRIVATE_KEY=${privateKey}\n`, { mode: 0o600 });

    const result = await execaNode(["--json", "wallet", "use", walletFile], { configPath });

    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: "wallet use", walletFile, address });
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.account).toEqual({
      walletMode: "POLY_1271",
      signatureType: 3,
      ownerSignerAddress: address,
      orderMakerAddress: depositWallet,
      orderSignerAddress: depositWallet,
      funderAddress: depositWallet
    });
  });
});
