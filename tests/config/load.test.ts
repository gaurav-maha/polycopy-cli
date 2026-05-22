import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.js";

describe("config loader", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves safe defaults without live secrets", async () => {
    const config = await loadConfig({ configPath: join(dir, "config.json"), command: "demo", env: {} });
    expect(config.copy.enableSell).toBe(false);
    expect(config.chainId).toBe(137);
    expect(config.runtime.dataDir).toBe("./.polycopy");
    expect(config.runtime.confirmationDepth).toBe(2);
  });

  it("maps non-secret RPC environment values", async () => {
    const config = await loadConfig({
      configPath: join(dir, "config.json"),
      command: "dry-run",
      env: {
        POLYGON_RPC_PRIMARY: "https://polygon.example/rpc"
      },
      overrides: {
        sourceWallets: ["0x9d84ce0306f8551e02efef1680475fc0f1dc1344"]
      }
    });
    expect(config.rpcProviders[0]?.url).toBe("https://polygon.example/rpc");
    expect(config.sourceWallets).toEqual(["0x9d84ce0306f8551e02efef1680475fc0f1dc1344"]);
  });
});
