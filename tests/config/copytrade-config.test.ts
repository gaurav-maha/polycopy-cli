import { buildCopytradeConfig } from "../../src/config/copytrade-config.js";

describe("copytrade config", () => {
  it("builds runtime config from leaders and rpc without a config file", async () => {
    const leader = "0x1111111111111111111111111111111111111111";
    const wallet = "0x2222222222222222222222222222222222222222";
    const config = await buildCopytradeConfig({
      leaders: [leader],
      rpcUrls: ["https://polygon.example/rpc", "https://polygon.example/fallback"],
      walletAddress: wallet,
      live: true,
      copyPct: "0.05"
    });

    expect(config.sourceWallets).toEqual([leader]);
    expect(config.rpcProviders).toEqual([
      { name: "primary", url: "https://polygon.example/rpc", maxLagMs: 30_000, maxLagBlocks: 1 },
      { name: "fallback", url: "https://polygon.example/fallback", maxLagMs: 30_000, maxLagBlocks: 1 }
    ]);
    expect(config.live.enabled).toBe(true);
    expect(config.risk.copyPct).toBe("0.05");
    expect(config.account).toMatchObject({
      walletMode: "EOA",
      ownerSignerAddress: wallet,
      funderAddress: wallet
    });
  });

  it("accepts user-facing percent and usd risk inputs", async () => {
    const leader = "0x1111111111111111111111111111111111111111";
    const config = await buildCopytradeConfig({
      leaders: [leader],
      rpcUrls: ["https://polygon.example/rpc", "https://polygon.example/fallback"],
      copyPct: "10",
      budgetUsd: "100",
      maxTradeSizeUsd: "2"
    });

    expect(config.risk.copyPct).toBe("0.10");
    expect(config.risk.freeBudgetPusdRaw).toBe("100000000");
    expect(config.risk.maxTradePusdRaw).toBe("2000000");
  });
});
