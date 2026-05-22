import { afterEach, describe, expect, it } from "vitest";
import { CTF } from "../../src/constants/chain.js";
import { MockClock, MockRpcAdapter, contractReadKey } from "../../src/adapters/mocks.js";
import {
  reconcileOnchainPositions,
  recordFollowerFills
} from "../../src/reconcile/positions.js";
import type { TempDb } from "../helpers/temp-db.js";
import { createMigratedTempDb } from "../helpers/temp-db.js";
import { insertExecutionGraph } from "../execution/sqlite-fixtures.js";

const signedHash = `0x${"a".repeat(64)}` as const;
const owner = "0x1111111111111111111111111111111111111111" as const;

describe("position reconciliation", () => {
  let tempDb: TempDb | undefined;

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = undefined;
  });

  it("records follower fills idempotently and updates positions from our fills", async () => {
    tempDb = await createMigratedTempDb();
    insertExecutionGraph(tempDb.db, {
      groupId: "group-buy",
      decisionId: "decision-buy",
      orderId: "order-buy",
      currentState: "SUBMITTED"
    });
    tempDb.db.prepare("UPDATE order_submissions SET signed_order_hash = ? WHERE id = ?").run(signedHash, "order-buy");

    const fill = {
      orderSubmissionId: "order-buy",
      signedOrderHash: signedHash,
      clobFillId: "trade-1",
      fillHash: "fill-1",
      side: "BUY" as const,
      tokenId: "123",
      pricePpm: "500000",
      sizeRaw: "40",
      pUsdDeltaRaw: "-20",
      feeRaw: "1",
      occurredAt: "2026-05-22T12:00:00.000Z"
    };

    expect(recordFollowerFills(tempDb.db, { fills: [fill] })).toEqual({ insertedFills: 1, insertedMovements: 1 });
    expect(recordFollowerFills(tempDb.db, { fills: [fill] })).toEqual({ insertedFills: 0, insertedMovements: 0 });

    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM follower_fills").get()).toEqual({ count: 1 });
    expect(tempDb.db.prepare("SELECT movement_type, shares_delta_raw, p_usd_delta_raw FROM position_movements").get()).toEqual({
      movement_type: "BUY_FILL",
      shares_delta_raw: "40",
      p_usd_delta_raw: "-20"
    });
    expect(tempDb.db.prepare("SELECT shares_raw, expected_onchain_shares_raw, last_onchain_shares_raw FROM positions WHERE token_id = ?").get("123")).toEqual({
      shares_raw: "40",
      expected_onchain_shares_raw: "40",
      last_onchain_shares_raw: "0"
    });
  });

  it("records reconciliation OK when on-chain balances match expected positions", async () => {
    tempDb = await createMigratedTempDb();
    tempDb.db
      .prepare("INSERT INTO positions (token_id, shares_raw, expected_onchain_shares_raw) VALUES ('123', '40', '40')")
      .run();
    const clock = new MockClock(Date.UTC(2026, 4, 22, 12));
    const rpc = new MockRpcAdapter({
      clock,
      blocks: [{ number: 1n, hash: `0x${"1".repeat(64)}`, timestampMs: clock.nowMs() }],
      contractReads: {
        [contractReadKey(CTF, "balanceOf", [owner, 123n])]: 40n
      }
    });

    const result = await reconcileOnchainPositions(tempDb.db, rpc, {
      owner,
      tokenIds: ["123"],
      nowIso: "2026-05-22T12:00:00.000Z",
      runType: "PERIODIC"
    });

    expect(result.status).toBe("OK");
    expect(result.divergences).toEqual([]);
    expect(tempDb.db.prepare("SELECT status FROM reconciliation_runs").get()).toEqual({ status: "OK" });
    expect(tempDb.db.prepare("SELECT last_onchain_shares_raw, last_reconciled_at FROM positions WHERE token_id = '123'").get()).toEqual({
      last_onchain_shares_raw: "40",
      last_reconciled_at: "2026-05-22T12:00:00.000Z"
    });
    expect(tempDb.db.prepare("SELECT value FROM runtime_state WHERE key = 'live_halt_reconciliation_divergence'").get()).toBeUndefined();
  });

  it("halts live and preserves local expected position when on-chain balance diverges", async () => {
    tempDb = await createMigratedTempDb();
    tempDb.db
      .prepare("INSERT INTO positions (token_id, shares_raw, expected_onchain_shares_raw) VALUES ('123', '40', '40')")
      .run();
    const clock = new MockClock(Date.UTC(2026, 4, 22, 12));
    const rpc = new MockRpcAdapter({
      clock,
      blocks: [{ number: 1n, hash: `0x${"1".repeat(64)}`, timestampMs: clock.nowMs() }],
      contractReads: {
        [contractReadKey(CTF, "balanceOf", [owner, 123n])]: 37n
      }
    });

    const result = await reconcileOnchainPositions(tempDb.db, rpc, {
      owner,
      tokenIds: ["123"],
      nowIso: "2026-05-22T12:00:00.000Z",
      runType: "PERIODIC"
    });

    expect(result.status).toBe("DIVERGED");
    expect(result.divergences).toEqual([{ tokenId: "123", expectedRaw: "40", onchainRaw: "37", deltaRaw: "-3" }]);
    expect(tempDb.db.prepare("SELECT shares_raw, expected_onchain_shares_raw, last_onchain_shares_raw FROM positions WHERE token_id = '123'").get()).toEqual({
      shares_raw: "40",
      expected_onchain_shares_raw: "40",
      last_onchain_shares_raw: "37"
    });
    expect(tempDb.db.prepare("SELECT movement_type, shares_delta_raw FROM position_movements").get()).toEqual({
      movement_type: "RECONCILE_ADJUSTMENT",
      shares_delta_raw: "-3"
    });
    const halt = tempDb.db.prepare("SELECT value FROM runtime_state WHERE key = 'live_halt_reconciliation_divergence'").get() as {
      value: string;
    };
    expect(JSON.parse(halt.value)).toMatchObject({
      status: "DIVERGED",
      divergences: [{ tokenId: "123", expectedRaw: "40", onchainRaw: "37", deltaRaw: "-3" }]
    });
  });

  it("halts live when observed pUSD balance diverges from local fill accounting", async () => {
    tempDb = await createMigratedTempDb();
    insertExecutionGraph(tempDb.db, {
      groupId: "group-pusd",
      decisionId: "decision-pusd",
      orderId: "order-pusd",
      currentState: "SUBMITTED"
    });
    tempDb.db.prepare("UPDATE order_submissions SET signed_order_hash = ? WHERE id = ?").run(signedHash, "order-pusd");
    recordFollowerFills(tempDb.db, {
      fills: [
        {
          orderSubmissionId: "order-pusd",
          signedOrderHash: signedHash,
          clobFillId: "trade-pusd",
          fillHash: "fill-pusd",
          side: "BUY",
          tokenId: "123",
          pricePpm: "500000",
          sizeRaw: "40",
          pUsdDeltaRaw: "-20",
          feeRaw: "1",
          occurredAt: "2026-05-22T12:00:00.000Z"
        }
      ]
    });
    const clock = new MockClock(Date.UTC(2026, 4, 22, 12));
    const rpc = new MockRpcAdapter({
      clock,
      blocks: [{ number: 1n, hash: `0x${"1".repeat(64)}`, timestampMs: clock.nowMs() }],
      contractReads: {
        [contractReadKey(CTF, "balanceOf", [owner, 123n])]: 40n
      }
    });

    const result = await reconcileOnchainPositions(tempDb.db, rpc, {
      owner,
      tokenIds: ["123"],
      nowIso: "2026-05-22T12:00:00.000Z",
      runType: "POST_FILL",
      startingPUsdBalanceRaw: "100",
      pUsdBalanceRaw: "78"
    });

    expect(result.status).toBe("DIVERGED");
    expect(result.pUsdDivergence).toEqual({ expectedRaw: "79", observedRaw: "78", deltaRaw: "-1" });
    const run = tempDb.db.prepare("SELECT status, p_usd_balance_raw, details_json FROM reconciliation_runs").get() as {
      status: string;
      p_usd_balance_raw: string;
      details_json: string;
    };
    expect(run.status).toBe("DIVERGED");
    expect(run.p_usd_balance_raw).toBe("78");
    expect(JSON.parse(run.details_json)).toMatchObject({
      pUsdDivergence: { expectedRaw: "79", observedRaw: "78", deltaRaw: "-1" }
    });
    const halt = tempDb.db.prepare("SELECT value FROM runtime_state WHERE key = 'live_halt_reconciliation_divergence'").get() as {
      value: string;
    };
    expect(JSON.parse(halt.value)).toMatchObject({
      status: "DIVERGED",
      pUsdDivergence: { expectedRaw: "79", observedRaw: "78", deltaRaw: "-1" }
    });
  });
});
