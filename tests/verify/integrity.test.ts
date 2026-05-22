import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyIntegrity } from "../../src/verify/integrity.js";

describe("verifyIntegrity", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-verify-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("verifies offline constants and writes a getter snapshot from injected getters", async () => {
    const snapshotPath = join(dir, "getter_snapshot.json");
    const result = await verifyIntegrity({
      getterSnapshotPath: snapshotPath,
      writeSnapshot: true,
      rpc: {
        getCode: async () => "0x01",
        readContract: async ({ address, functionName }): Promise<unknown> => {
          const standard = address.toLowerCase().startsWith("0xe111");
          const values: Record<string, string> = {
            getCollateral: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
            getCtf: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
            getCtfCollateral: standard
              ? "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
              : "0x3A3BD7bb9528E159577F7C2e685CC81A765002E2",
            getOutcomeTokenFactory: standard
              ? "0xADa100874d00e3331D00F2007a9c336a65009718"
              : "0xAdA200001000ef00D07553cEE7006808F895c6F1"
          };
          return values[functionName] as `0x${string}`;
        }
      }
    });

    expect(result.ok).toBe(true);
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    expect(snapshot.standardExchange.bytecodePresent).toBe(true);
    expect(snapshot.negRiskExchange.getCtfCollateral).toBe("0x3A3BD7bb9528E159577F7C2e685CC81A765002E2");
  });
});
