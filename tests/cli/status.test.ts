import { afterEach, describe, expect, it } from "vitest";
import type { TempDb } from "../helpers/temp-db.js";
import { createMigratedTempDb } from "../helpers/temp-db.js";
import { execaNode } from "../helpers/execa-node.js";

describe("CLI status", () => {
  let tempDb: TempDb | undefined;

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = undefined;
  });

  it("prints compact live halt summary while preserving runtime state rows", async () => {
    tempDb = await createMigratedTempDb();
    const divergence = {
      runId: "reconcile-run-1",
      status: "DIVERGED",
      divergences: [
        { tokenId: "123", expectedRaw: "40", onchainRaw: "37", deltaRaw: "-3" },
        { tokenId: "456", expectedRaw: "10", onchainRaw: "0", deltaRaw: "-10" }
      ],
      at: "2026-05-22T12:00:00.000Z"
    };
    const insertState = tempDb.db.prepare("INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)");
    insertState.run("last_processed_block", "102", "2026-05-22T12:00:01.000Z");
    insertState.run("live_halt_reconciliation_divergence", JSON.stringify(divergence), "2026-05-22T12:00:02.000Z");
    insertState.run("live_halt_reorg_orphan", "1", "2026-05-22T12:00:03.000Z");

    const result = await execaNode(["status", "--db", tempDb.path]);
    const payload = JSON.parse(result.stdout);

    expect(payload).toMatchObject({
      ok: true,
      liveHalt: {
        halted: true,
        reasons: ["reconciliation_divergence", "reorg_orphan"],
        reconciliationDivergence: {
          runId: "reconcile-run-1",
          status: "DIVERGED",
          divergences: 2,
          at: "2026-05-22T12:00:00.000Z"
        },
        reorgOrphan: true
      }
    });
    expect(payload.runtimeState).toEqual([
      { key: "last_processed_block", value: "102", updated_at: "2026-05-22T12:00:01.000Z" },
      {
        key: "live_halt_reconciliation_divergence",
        value: JSON.stringify(divergence),
        updated_at: "2026-05-22T12:00:02.000Z"
      },
      { key: "live_halt_reorg_orphan", value: "1", updated_at: "2026-05-22T12:00:03.000Z" }
    ]);
  });
});
