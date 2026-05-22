import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORDER_FILLED_TOPIC } from "../../src/constants/abi.js";
import { verifyFixtureManifest } from "../../src/verify/fixtures.js";

describe("fixture manifest verifier", () => {
  it("verifies raw fixture logs through decode, normalization, and aggregation", async () => {
    const result = await verifyFixtureManifest({ manifestPath: "fixtures/manifest.json", fixture: "all" });

    expect(result.ok).toBe(true);
    expect(result.cases).toBeGreaterThanOrEqual(8);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ caseId: "accepted-taker-buy", name: "decode", ok: true }),
        expect.objectContaining({ caseId: "accepted-taker-buy", name: "normalization", ok: true }),
        expect.objectContaining({ caseId: "multi-fill-grouping", name: "aggregation", ok: true }),
        expect.objectContaining({ caseId: "mint-merge-skip", name: "decode_rejected", ok: true })
      ])
    );
  });

  it("fails when an OrderFilled fixture uses the wrong event topic", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polycopy-fixture-verify-"));
    try {
      const manifest = JSON.parse(await readFile("fixtures/manifest.json", "utf8")) as {
        cases: Array<{ id: string; source?: { rawLog?: unknown; rawLogPath?: string } }>;
      };
      const buy = manifest.cases.find((entry) => entry.id === "accepted-taker-buy");
      if (!buy?.source?.rawLogPath) throw new Error("accepted-taker-buy fixture missing rawLogPath");
      buy.source.rawLog = JSON.parse(await readFile(buy.source.rawLogPath, "utf8"));
      delete buy.source.rawLogPath;
      (buy.source.rawLog as { topics: string[] }).topics[0] = ORDER_FILLED_TOPIC.replace(/.$/, "0");

      const manifestPath = join(dir, "manifest.json");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await verifyFixtureManifest({ manifestPath, fixture: "accepted-taker-buy" });

      expect(result.ok).toBe(false);
      expect(result.checks).toEqual(
        expect.arrayContaining([expect.objectContaining({ caseId: "accepted-taker-buy", name: "decode", ok: false })])
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
