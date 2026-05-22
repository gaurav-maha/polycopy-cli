import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaNode } from "../helpers/execa-node.js";

describe("persistent config commands", () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-cli-config-"));
    configPath = join(dir, "config.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("initializes, validates, and prints the configured path", async () => {
    const init = await execaNode(["--json", "init"], { configPath });
    expect(JSON.parse(init.stdout)).toMatchObject({ ok: true, path: configPath });

    const path = await execaNode(["--json", "config", "path"], { configPath });
    expect(JSON.parse(path.stdout)).toMatchObject({ ok: true, path: configPath });

    const validate = await execaNode(["--json", "config", "validate"], { configPath });
    expect(JSON.parse(validate.stdout)).toMatchObject({ ok: true });
  });

  it("honors the global --config option", async () => {
    const explicitConfigPath = join(dir, "global-config.json");
    const init = await execaNode(["--config", explicitConfigPath, "--json", "init"]);
    expect(JSON.parse(init.stdout)).toMatchObject({ ok: true, path: explicitConfigPath });

    const path = await execaNode(["--config", explicitConfigPath, "--json", "config", "path"]);
    expect(JSON.parse(path.stdout)).toMatchObject({ ok: true, path: explicitConfigPath });
  });

  it("sets and shows exactly one leader wallet", async () => {
    const leader = "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344";
    await execaNode(["--json", "init"], { configPath });
    await execaNode(["--json", "leader", "set", leader], { configPath });

    const show = await execaNode(["--json", "leader", "show"], { configPath });
    expect(JSON.parse(show.stdout)).toEqual({ ok: true, leader, leaders: [leader] });

    const file = JSON.parse(await readFile(configPath, "utf8"));
    expect(file.sourceWallets).toEqual([leader]);
  });

  it("adds, lists, and removes leader wallets", async () => {
    const leaderA = "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344";
    const leaderB = "0x1111111111111111111111111111111111111111";
    await execaNode(["--json", "init"], { configPath });
    await execaNode(["--json", "leader", "add", leaderA], { configPath });
    await execaNode(["--json", "leader", "add", leaderB], { configPath });

    const list = await execaNode(["--json", "leader", "list"], { configPath });
    expect(JSON.parse(list.stdout)).toEqual({
      ok: true,
      leaders: [
        { address: leaderA, enabled: true },
        { address: leaderB, enabled: true }
      ]
    });

    await execaNode(["--json", "leader", "remove", leaderB], { configPath });
    const file = JSON.parse(await readFile(configPath, "utf8"));
    expect(file.sourceWallets).toEqual([leaderA]);
  });

  it("sets allowlisted non-secret config values atomically", async () => {
    await execaNode(["--json", "init"], { configPath });
    await execaNode(["--json", "config", "set", "--copy-pct", "0.20", "--enable-sell", "true"], { configPath });

    const get = await execaNode(["--json", "config", "get"], { configPath });
    const payload = JSON.parse(get.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.config.copy.enableSell).toBe(true);
    expect(payload.config.risk.copyPct).toBe("0.20");
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_KEY");
  });

  it("stores a local wallet file path without storing secrets", async () => {
    const walletFile = join(dir, "wallet.env");
    await execaNode(["--json", "init"], { configPath });
    await execaNode(["--json", "config", "set", "--secrets", walletFile], { configPath });

    const file = JSON.parse(await readFile(configPath, "utf8"));
    expect(file.runtime.secretsPath).toBe(walletFile);

    const get = await execaNode(["--json", "config", "get"], { configPath });
    const payload = JSON.parse(get.stdout);
    expect(payload.config.runtime.secretsPath).toBe(walletFile);
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_KEY");
    expect(JSON.stringify(payload)).not.toContain("CLOB_SECRET");
  });

  it("sets a POLY_1271 deposit wallet account without storing secrets", async () => {
    const owner = "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344";
    const depositWallet = "0x3333333333333333333333333333333333333333";
    await execaNode(["--json", "init"], { configPath });

    const result = await execaNode(
      ["--json", "config", "set", "--wallet-mode", "POLY_1271", "--owner", owner, "--deposit-wallet", depositWallet],
      { configPath }
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, account: { walletMode: "POLY_1271" } });

    const file = JSON.parse(await readFile(configPath, "utf8"));
    expect(file.account).toEqual({
      walletMode: "POLY_1271",
      signatureType: 3,
      ownerSignerAddress: owner,
      orderMakerAddress: depositWallet,
      orderSignerAddress: depositWallet,
      funderAddress: depositWallet
    });
  });
});
