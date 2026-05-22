import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaNode } from "../helpers/execa-node.js";

describe("copytrade CLI", () => {
  let dir: string;
  let rpcPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-copytrade-"));
    rpcPath = join(dir, "rpc.json");
    await execaNode(["--json", "rpc", "add", "https://polygon.example/rpc"], { rpcPath });
    await execaNode(["--json", "rpc", "add", "https://polygon.example/fallback"], { rpcPath });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("requires leader addresses", async () => {
    const result = await execaNode(["--json", "copytrade"], { reject: false, rpcPath });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/leader/i);
  });

  it("requires configured rpc when none is saved", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "polycopy-copytrade-empty-"));
    const emptyRpcPath = join(emptyDir, "rpc.json");
    try {
      const result = await execaNode(
        ["--json", "copytrade", "0x1111111111111111111111111111111111111111"],
        { reject: false, rpcPath: emptyRpcPath }
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/rpc add/i);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("allows dry-run without live secrets", async () => {
    const result = await execaNode(
      [
        "--json",
        "copytrade",
        "0x1111111111111111111111111111111111111111",
        "--dry-run",
        "--duration-minutes",
        "0",
        "--max-iterations",
        "0"
      ],
      { reject: false, rpcPath }
    );
    expect(result.stdout + result.stderr).not.toMatch(/ACK_LIVE_RISK_REQUIRED/i);
  });

  it.each([
    ["duration-minutes", "abc"],
    ["duration-minutes", "1abc"],
    ["poll-ms", "abc"],
    ["lookback-blocks", "-1"],
    ["confirmation-depth", "1"],
    ["max-iterations", "abc"]
  ])("rejects invalid dry-run numeric option --%s=%s", async (option, value) => {
    const result = await execaNode(
      [
        "--json",
        "copytrade",
        "0x1111111111111111111111111111111111111111",
        "--dry-run",
        "--duration-minutes",
        "0",
        "--max-iterations",
        "0",
        `--${option}`,
        value
      ],
      { reject: false, rpcPath }
    );
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: "COPYTRADE_INVALID_OPTION",
      option
    });
  });

  it("rejects invalid live max cycles before loading secrets", async () => {
    const result = await execaNode(
      [
        "--json",
        "copytrade",
        "0x1111111111111111111111111111111111111111",
        "--secrets",
        join(dir, "missing.env"),
        "--max-cycles",
        "0"
      ],
      { reject: false, rpcPath }
    );

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: "COPYTRADE_INVALID_OPTION",
      option: "max-cycles"
    });
  });

  it("defaults to live mode and refuses unconfigured EOA before loading secrets", async () => {
    const configPath = join(dir, "empty-config.json");
    const result = await execaNode(
      [
        "--json",
        "copytrade",
        "0x1111111111111111111111111111111111111111",
        "--secrets",
        join(dir, "missing.env"),
        "--duration-minutes",
        "0"
      ],
      { reject: false, rpcPath, configPath }
    );
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: "UNSUPPORTED_WALLET_MODE"
    });
    expect(result.stdout).toMatch(/configure POLY_1271 or POLY_PROXY/i);
  });

  it("requires live secrets after a deposit wallet account is configured", async () => {
    const configPath = join(dir, "config.json");
    const leader = "0x1111111111111111111111111111111111111111";
    const owner = "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344";
    const depositWallet = "0x3333333333333333333333333333333333333333";
    await execaNode(["--json", "init"], { configPath });
    await execaNode(
      [
        "--json",
        "config",
        "set",
        "--leader",
        leader,
        "--live-enabled",
        "true",
        "--rpc-primary",
        "https://polygon.example/rpc",
        "--rpc-fallback",
        "https://polygon.example/fallback",
        "--wallet-mode",
        "POLY_1271",
        "--owner",
        owner,
        "--deposit-wallet",
        depositWallet
      ],
      { configPath }
    );

    const result = await execaNode(
      [
        "--json",
        "copytrade",
        "--config",
        configPath,
        "--secrets",
        join(dir, "missing.env"),
        "--duration-minutes",
        "0"
      ],
      { reject: false }
    );
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: "COPYTRADE_FAILED"
    });
    expect(result.stdout).toMatch(/live requires PRIVATE_KEY, CLOB_API_KEY, CLOB_SECRET, and CLOB_PASS_PHRASE/i);
  });
});
