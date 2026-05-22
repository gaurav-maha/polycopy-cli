import { execaNode } from "../helpers/execa-node.js";

describe("verify CLI", () => {
  it("serializes fixture verification output containing bigint details", async () => {
    const result = await execaNode(["--json", "verify", "--fixture", "all"]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ ok: true, fixture: "all" });
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "fixture", caseId: "accepted-taker-buy", name: "decode", ok: true })
      ])
    );
  });
});
