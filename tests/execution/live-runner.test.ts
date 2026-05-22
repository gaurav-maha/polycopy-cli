import { afterEach, describe, expect, it } from "vitest";
import type { CancelResult, Hex, OrderStatusResult, SignedClobOrder, SubmitResult } from "../../src/adapters/types.js";
import { MockClobRestAdapter, MockClock, MockRpcAdapter } from "../../src/adapters/mocks.js";
import { CTF, CTF_EXCHANGE_V2, PUSD } from "../../src/constants/chain.js";
import { runLiveTradingCycle, type LiveOrderSigner } from "../../src/execution/live-runner.js";
import type { TempDb } from "../helpers/temp-db.js";
import { createMigratedTempDb } from "../helpers/temp-db.js";
import { insertCopyDecision } from "../execution/sqlite-fixtures.js";

const owner = "0x1111111111111111111111111111111111111111" as const;
const funder = "0x3333333333333333333333333333333333333333" as const;
const leader = "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344" as const;
const tokenId = "123456789";
const nowMs = Date.UTC(2026, 4, 22, 12);
const nowIso = new Date(nowMs).toISOString();
const signedOrderHash = `0x${"a".repeat(64)}` as const;
const settlementTxHash = `0x${"d".repeat(64)}` as const;
const encryptionKey = new Uint8Array(32).fill(7);
const signBoundary = {
  maxBookAgeMs: 800,
  maxDriftPpm: 30_000,
  maxBuyPpm: 980_000,
  minSellPpm: 20_000,
  slippageCapPpm: 50_000
};

describe("live trading runner", () => {
  let tempDb: TempDb | undefined;

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = undefined;
  });

  it("creates an encrypted outbox row, submits it, and reconciles matched fills", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedDecision(tempDb.db);
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      books: [liveBook(nowMs)],
      balances: [collateralBalance("1000000", "1000000")],
      orderStatuses: {
        [signedOrderHash]: orderStatus("matched", [
          {
            tradeId: "trade-live-1",
            fillHash: "fill-live-1",
            pricePpm: 500_000,
            sizeRaw: "50",
            pUsdDeltaRaw: "-25",
            feeRaw: "0",
            occurredAt: nowIso
          }
        ])
      }
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [owner])]: 1_000_000n,
        [contractReadKey(PUSD, "allowance", [owner, CTF_EXCHANGE_V2])]: 1_000_000n,
        [contractReadKey(CTF, "balanceOf", [owner, tokenId])]: 50n
      }
    });

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: fixedSigner(),
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: true,
      balanceMismatchToleranceRaw: "0",
      nowMs,
      nowIso,
      signBoundary,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({ submitted: 1, reconciled: 1, rejected: 0, timeoutUnknown: 0, halted: false });
    expect(orderSummary(tempDb, signedOrderHash)).toEqual({
      current_state: "ACK_FILLED",
      filled_size_raw: "50",
      abandoned_size_raw: "0",
      encrypted_signed_payload_json: null,
      payload_erased_at: nowIso
    });
    expect(tempDb.db.prepare("SELECT state, released_at, source_wallet FROM risk_reservations").get()).toEqual({
      state: "RELEASED",
      released_at: nowIso,
      source_wallet: leader
    });
    expect(tempDb.db.prepare("SELECT reserved_spend_pusd_raw, realized_spend_pusd_raw, trade_count FROM leader_budgets").get()).toEqual({
      reserved_spend_pusd_raw: "0",
      realized_spend_pusd_raw: "25",
      trade_count: 1
    });
    expect(tempDb.db.prepare("SELECT from_state, to_state, action FROM order_attempts ORDER BY created_at, rowid").all()).toEqual([
      { from_state: null, to_state: "CREATED", action: "CREATED" },
      { from_state: "CREATED", to_state: "SUBMITTING", action: "SUBMIT_START" },
      { from_state: "SUBMITTING", to_state: "SUBMITTED", action: "SUBMIT_ACK" },
      { from_state: "SUBMITTED", to_state: "ACK_FILLED", action: "ACK_FILLED" }
    ]);
  });

  it("reconciles POLY_1271 fills against the funder deposit wallet", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedDecision(tempDb.db);
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      books: [liveBook(nowMs)],
      balances: [
        {
          assetType: "COLLATERAL",
          expectedFunder: funder,
          expectedSpender: CTF_EXCHANGE_V2,
          expectedSignatureType: 3,
          balanceRaw: "1000000",
          allowanceRaw: "1000000",
          receivedAtMs: nowMs,
          raw: { fixture: true }
        }
      ],
      orderStatuses: {
        [signedOrderHash]: orderStatus("matched", [
          {
            tradeId: "trade-live-poly1271",
            fillHash: "fill-live-poly1271",
            pricePpm: 500_000,
            sizeRaw: "50",
            pUsdDeltaRaw: "-25",
            feeRaw: "0",
            occurredAt: nowIso
          }
        ])
      }
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [funder])]: 1_000_000n,
        [contractReadKey(PUSD, "allowance", [funder, CTF_EXCHANGE_V2])]: 1_000_000n,
        [contractReadKey(CTF, "balanceOf", [funder, tokenId])]: 50n
      }
    });

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: mutatedBuySigner({ maker: funder, signer: funder, signatureType: 3 }),
      rpc,
      owner,
      funder,
      signatureType: 3,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: true,
      balanceMismatchToleranceRaw: "0",
      nowMs,
      nowIso,
      signBoundary,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({ submitted: 1, reconciled: 1, rejected: 0, timeoutUnknown: 0, halted: false });
    expect(tempDb.db.prepare("SELECT last_onchain_shares_raw FROM positions WHERE token_id = ?").get(tokenId)).toEqual({
      last_onchain_shares_raw: "50"
    });
    expect(tempDb.db.prepare("SELECT value FROM runtime_state WHERE key = 'live_halt_reconciliation_divergence'").get()).toBeUndefined();
  });

  it("waits for matched settlement transaction receipts before reconciling on-chain balances", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedDecision(tempDb.db);
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      books: [liveBook(nowMs)],
      balances: [collateralBalance("1000000", "1000000")],
      submitResults: {
        [signedOrderHash]: submitResult({ success: true, status: "matched", transactionsHashes: [settlementTxHash] })
      },
      orderStatuses: {
        [signedOrderHash]: orderStatus("matched", [
          {
            tradeId: "trade-live-pending-receipt",
            fillHash: "fill-live-pending-receipt",
            pricePpm: 500_000,
            sizeRaw: "50",
            pUsdDeltaRaw: "-25",
            feeRaw: "0",
            occurredAt: nowIso
          }
        ])
      }
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [owner])]: 1_000_000n,
        [contractReadKey(PUSD, "allowance", [owner, CTF_EXCHANGE_V2])]: 1_000_000n
      }
    });

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: fixedSigner(),
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: true,
      balanceMismatchToleranceRaw: "0",
      nowMs,
      nowIso,
      signBoundary,
      settlementReceiptWaitMs: 0,
      settlementReceiptPollMs: 0,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({ submitted: 1, reconciled: 0, timeoutUnknown: 1, halted: false });
    expect(orderSummary(tempDb, signedOrderHash)).toMatchObject({
      current_state: "SUBMITTED",
      filled_size_raw: "0"
    });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM follower_fills").get()).toEqual({ count: 0 });
    expect((tempDb.db.prepare("SELECT last_error FROM order_submissions WHERE signed_order_hash = ?").get(signedOrderHash) as { last_error: string }).last_error)
      .toContain("SETTLEMENT_RECEIPT_PENDING");
  });

  it("accepts string leaderPricePpm snapshots written by ingestion", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedDecision(tempDb.db);
    tempDb.db
      .prepare(
        `
          UPDATE copy_decisions
          SET gate_snapshot_json = ?
          WHERE id = 'live-decision'
        `
      )
      .run(
        JSON.stringify({
          leaderPricePpm: "500000",
          limitPpm: 500_000,
          book: { intendedSizeRaw: "50", vwapPpm: 500_000 },
          metadata: { tickSize: "0.01", negRisk: false }
        })
      );
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      books: [liveBook(nowMs)],
      balances: [collateralBalance("1000000", "1000000")],
      orderStatuses: { [signedOrderHash]: orderStatus("live", []) }
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [owner])]: 1_000_000n,
        [contractReadKey(PUSD, "allowance", [owner, CTF_EXCHANGE_V2])]: 1_000_000n
      }
    });

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: fixedSigner(),
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: true,
      balanceMismatchToleranceRaw: "0",
      nowMs,
      nowIso,
      signBoundary,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({ considered: 1, outboxed: 1, submitted: 1, errors: 0 });
  });

  it("rejects SDK-downsized BUY orders before outbox with a fee-headroom error", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedDecision(tempDb.db);
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      books: [liveBook(nowMs)],
      balances: [collateralBalance("25", "25")]
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [owner])]: 25n,
        [contractReadKey(PUSD, "allowance", [owner, CTF_EXCHANGE_V2])]: 25n
      }
    });

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: downsizedBuySigner("23"),
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: true,
      balanceMismatchToleranceRaw: "0",
      nowMs,
      nowIso,
      signBoundary,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({ considered: 1, errors: 1, outboxed: 0, submitted: 0, rejected: 0 });
    expect(tempDb.db.prepare("SELECT status, error_reason FROM copy_decisions WHERE id = 'live-decision'").get()).toEqual({
      status: "ERROR",
      error_reason: "INSUFFICIENT_PUSD_FEE_HEADROOM: approvedNotionalRaw=25 signedMakerAmountRaw=23 sdkAdjustmentRaw=2"
    });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM order_submissions").get()).toEqual({ count: 0 });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM risk_reservations").get()).toEqual({ count: 0 });
  });

  it("rejects BUY orders with a signed price above the approved limit before outbox", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedDecision(tempDb.db);
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      books: [liveBook(nowMs)],
      balances: [collateralBalance("1000000", "1000000")]
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [owner])]: 1_000_000n,
        [contractReadKey(PUSD, "allowance", [owner, CTF_EXCHANGE_V2])]: 1_000_000n
      }
    });

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: mutatedBuySigner({ takerAmount: "1" }),
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: true,
      balanceMismatchToleranceRaw: "0",
      nowMs,
      nowIso,
      signBoundary,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({ considered: 1, errors: 1, outboxed: 0, submitted: 0 });
    expect(tempDb.db.prepare("SELECT status, error_reason FROM copy_decisions WHERE id = 'live-decision'").get()).toEqual({
      status: "ERROR",
      error_reason: "SIGNED_BUY_PRICE_ABOVE_LIMIT: limitPricePpm=550000 signedMakerAmountRaw=25 signedTakerAmountRaw=1"
    });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM order_submissions").get()).toEqual({ count: 0 });
  });

  it("stores the SDK signed BUY size instead of the pre-sign book estimate", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedDecision(tempDb.db);
    tempDb.db
      .prepare("UPDATE copy_decisions SET gate_snapshot_json = ? WHERE id = 'live-decision'")
      .run(
        JSON.stringify({
          leaderPricePpm: 500_000,
          limitPpm: 500_000,
          book: { intendedSizeRaw: "1000", vwapPpm: 25_000 },
          metadata: { tickSize: "0.01", negRisk: false }
        })
      );
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      balances: [collateralBalance("1000000", "1000000")],
      orderStatuses: { [signedOrderHash]: orderStatus("live", []) }
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [owner])]: 1_000_000n,
        [contractReadKey(PUSD, "allowance", [owner, CTF_EXCHANGE_V2])]: 1_000_000n
      }
    });

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: fixedSigner(),
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: true,
      balanceMismatchToleranceRaw: "0",
      nowMs,
      nowIso,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({ considered: 1, outboxed: 1, submitted: 1, errors: 0 });
    expect(tempDb.db.prepare("SELECT intended_size_raw FROM order_submissions WHERE copy_decision_id = 'live-decision'").get()).toEqual({
      intended_size_raw: "50"
    });
  });

  it("rejects signed orders whose maker/signature boundary does not match the live account", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedDecision(tempDb.db);
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      books: [liveBook(nowMs)],
      balances: [collateralBalance("1000000", "1000000")]
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [owner])]: 1_000_000n,
        [contractReadKey(PUSD, "allowance", [owner, CTF_EXCHANGE_V2])]: 1_000_000n
      }
    });

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: mutatedBuySigner({ maker: "0x2222222222222222222222222222222222222222" }),
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: true,
      balanceMismatchToleranceRaw: "0",
      nowMs,
      nowIso,
      signBoundary,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({ considered: 1, errors: 1, outboxed: 0, submitted: 0 });
    expect(tempDb.db.prepare("SELECT status, error_reason FROM copy_decisions WHERE id = 'live-decision'").get()).toEqual({
      status: "ERROR",
      error_reason:
        "SIGNED_ORDER_MAKER_MISMATCH: expectedMaker=0x1111111111111111111111111111111111111111 signedMaker=0x2222222222222222222222222222222222222222"
    });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM order_submissions").get()).toEqual({ count: 0 });
  });

  it("rejects BUY orders before signing when balance cannot cover estimated fees", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedDecision(tempDb.db);
    tempDb.db
      .prepare(
        `
          UPDATE copy_decisions
          SET gate_snapshot_json = ?
          WHERE id = 'live-decision'
        `
      )
      .run(
        JSON.stringify({
          leaderPricePpm: 500_000,
          limitPpm: 500_000,
          book: { intendedSizeRaw: "50", vwapPpm: 500_000 },
          metadata: {
            tickSize: "0.01",
            negRisk: false,
            feeConfig: { r: "0.07", e: "1", to: `0x${"0".repeat(40)}` }
          }
        })
      );
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      books: [liveBook(nowMs)],
      balances: [collateralBalance("25", "25")]
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [owner])]: 25n,
        [contractReadKey(PUSD, "allowance", [owner, CTF_EXCHANGE_V2])]: 25n
      }
    });
    let signCalls = 0;

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: {
        async signMarketOrder() {
          signCalls += 1;
          return fixedSigner().signMarketOrder({
            tokenId,
            side: "BUY",
            approvedNotionalRaw: 25n,
            intendedSizeRaw: 50n,
            limitPricePpm: 500_000,
            orderType: "FAK",
            tickSize: "0.01",
            negRisk: false
          });
        }
      },
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: true,
      balanceMismatchToleranceRaw: "0",
      nowMs,
      nowIso,
      signBoundary,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({ considered: 1, errors: 1, outboxed: 0, submitted: 0 });
    expect(signCalls).toBe(0);
    expect(tempDb.db.prepare("SELECT status, error_reason FROM copy_decisions WHERE id = 'live-decision'").get()).toEqual({
      status: "ERROR",
      error_reason:
        "INSUFFICIENT_PUSD_AVAILABLE: requiredRaw=26 currentOrderRaw=25 currentFeeHeadroomRaw=1 onchainPusdRaw=25 clobPusdRaw=25 allowanceRaw=25"
    });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM order_submissions").get()).toEqual({ count: 0 });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM risk_reservations").get()).toEqual({ count: 0 });
  });

  it("treats semantic CLOB rejection as zero-exposure terminal and releases reservations", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedDecision(tempDb.db);
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      books: [liveBook(nowMs)],
      balances: [collateralBalance("1000000", "1000000")],
      submitResults: {
        [signedOrderHash]: submitResult({
          success: false,
          errorCode: "INVALID_ORDER_MIN_SIZE",
          errorMsg: "minimum order size"
        })
      }
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [owner])]: 1_000_000n,
        [contractReadKey(PUSD, "allowance", [owner, CTF_EXCHANGE_V2])]: 1_000_000n
      }
    });

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: fixedSigner(),
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: true,
      balanceMismatchToleranceRaw: "0",
      nowMs,
      nowIso,
      signBoundary,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({ submitted: 0, reconciled: 0, rejected: 1, timeoutUnknown: 0, halted: false });
    expect(orderSummary(tempDb, signedOrderHash)).toMatchObject({
      current_state: "ACK_REJECTED",
      filled_size_raw: "0",
      abandoned_size_raw: "50",
      encrypted_signed_payload_json: null,
      payload_erased_at: nowIso
    });
    expect(tempDb.db.prepare("SELECT state, released_at FROM risk_reservations").get()).toEqual({
      state: "RELEASED",
      released_at: nowIso
    });
    expect(tempDb.db.prepare("SELECT reserved_spend_pusd_raw, realized_spend_pusd_raw, trade_count FROM leader_budgets").get()).toEqual({
      reserved_spend_pusd_raw: "0",
      realized_spend_pusd_raw: "0",
      trade_count: 1
    });
  });

  it("halts immediately when CLOB rejects the maker account setup", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedDecision(tempDb.db);
    insertSecondApprovedDecision(tempDb.db);
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      books: [liveBook(nowMs)],
      balances: [collateralBalance("1000000", "1000000")],
      submitResults: {
        [signedOrderHash]: submitResult({
          success: false,
          errorMsg: "maker address not allowed, please use the deposit wallet flow"
        })
      }
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [owner])]: 1_000_000n,
        [contractReadKey(PUSD, "allowance", [owner, CTF_EXCHANGE_V2])]: 1_000_000n
      }
    });
    let signCalls = 0;

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: {
        async signMarketOrder(args) {
          signCalls += 1;
          return fixedSigner().signMarketOrder(args);
        }
      },
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: false,
      balanceMismatchToleranceRaw: "0",
      nowMs,
      nowIso,
      signBoundary,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({ considered: 1, rejected: 1, submitted: 0, halted: true, haltReason: "CLOB_ACCOUNT_NOT_ALLOWED" });
    expect(signCalls).toBe(1);
    expect(tempDb.db.prepare("SELECT state, released_at FROM risk_reservations").get()).toEqual({
      state: "RELEASED",
      released_at: nowIso
    });
    expect(tempDb.db.prepare("SELECT value FROM runtime_state WHERE key = ?").get("live_halt.CLOB_ACCOUNT_NOT_ALLOWED")).toEqual({
      value: JSON.stringify({ reason: "CLOB_ACCOUNT_NOT_ALLOWED", orderSubmissionId: "os_live-decision", at: nowIso })
    });
  });

  it("halts immediately when CLOB rejects live trading for region/VPN restrictions", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedDecision(tempDb.db);
    insertSecondApprovedDecision(tempDb.db);
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      books: [liveBook(nowMs)],
      balances: [collateralBalance("1000000", "1000000")],
      submitResults: {
        [signedOrderHash]: submitResult({
          success: false,
          errorMsg: "Trading restricted in your region. Please ensure you are not using a VPN."
        })
      }
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [owner])]: 1_000_000n,
        [contractReadKey(PUSD, "allowance", [owner, CTF_EXCHANGE_V2])]: 1_000_000n
      }
    });
    let signCalls = 0;

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: {
        async signMarketOrder(args) {
          signCalls += 1;
          return fixedSigner().signMarketOrder(args);
        }
      },
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: false,
      balanceMismatchToleranceRaw: "0",
      nowMs,
      nowIso,
      signBoundary,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({ considered: 1, rejected: 1, submitted: 0, halted: true, haltReason: "CLOB_GEO_BLOCKED" });
    expect(signCalls).toBe(1);
    expect(tempDb.db.prepare("SELECT value FROM runtime_state WHERE key = ?").get("live_halt.CLOB_GEO_BLOCKED")).toEqual({
      value: JSON.stringify({ reason: "CLOB_GEO_BLOCKED", orderSubmissionId: "os_live-decision", at: nowIso })
    });
  });

  it("cancels and halts on unexpected resting FAK/FOK statuses", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedDecision(tempDb.db);
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      books: [liveBook(nowMs)],
      balances: [collateralBalance("1000000", "1000000")],
      submitResults: {
        [signedOrderHash]: submitResult({ success: true, status: "live" })
      },
      orderStatuses: {
        [signedOrderHash]: orderStatus("unknown", [])
      }
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [owner])]: 1_000_000n,
        [contractReadKey(PUSD, "allowance", [owner, CTF_EXCHANGE_V2])]: 1_000_000n
      }
    });

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: fixedSigner(),
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: true,
      balanceMismatchToleranceRaw: "0",
      nowMs,
      nowIso,
      signBoundary,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({
      submitted: 1,
      reconciled: 0,
      rejected: 0,
      timeoutUnknown: 1,
      halted: true,
      haltReason: "CLOB_LIVE_STATUS_UNEXPECTED"
    });
    expect(tempDb.db.prepare("SELECT current_state FROM order_submissions").get()).toEqual({
      current_state: "TIMEOUT_UNKNOWN"
    });
    expect(tempDb.db.prepare("SELECT value FROM runtime_state WHERE key = ?").get("live_halt.CLOB_LIVE_STATUS_UNEXPECTED")).toEqual({
      value: JSON.stringify({ reason: "CLOB_LIVE_STATUS_UNEXPECTED", orderSubmissionId: "os_live-decision", at: nowIso })
    });
  });

  it("persists the unexpected-resting halt even when cancel fails", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedDecision(tempDb.db);
    const clock = new MockClock(nowMs);
    class CancelFailingClob extends MockClobRestAdapter {
      async cancelByHash(_signedOrderHash: Hex): Promise<CancelResult> {
        throw new Error("fixture cancel failed");
      }
    }
    const clob = new CancelFailingClob({
      clock,
      books: [liveBook(nowMs)],
      balances: [collateralBalance("1000000", "1000000")],
      submitResults: {
        [signedOrderHash]: submitResult({ success: true, status: "live" })
      },
      orderStatuses: {
        [signedOrderHash]: orderStatus("unknown", [])
      }
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [owner])]: 1_000_000n,
        [contractReadKey(PUSD, "allowance", [owner, CTF_EXCHANGE_V2])]: 1_000_000n
      }
    });

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: fixedSigner(),
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: true,
      balanceMismatchToleranceRaw: "0",
      nowMs,
      nowIso,
      signBoundary,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({
      submitted: 1,
      timeoutUnknown: 1,
      halted: true,
      haltReason: "CLOB_LIVE_STATUS_UNEXPECTED"
    });
    expect(tempDb.db.prepare("SELECT current_state, last_error FROM order_submissions").get()).toEqual({
      current_state: "TIMEOUT_UNKNOWN",
      last_error: "cancelByHash failed after unexpected resting status: fixture cancel failed"
    });
    expect(tempDb.db.prepare("SELECT value FROM runtime_state WHERE key = ?").get("live_halt.CLOB_LIVE_STATUS_UNEXPECTED")).toEqual({
      value: JSON.stringify({ reason: "CLOB_LIVE_STATUS_UNEXPECTED", orderSubmissionId: "os_live-decision", at: nowIso })
    });
  });

  it("submits and reconciles matched SELL fills", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedSellDecision(tempDb.db);
    tempDb.db.prepare(
      `
        INSERT INTO positions (token_id, shares_raw, expected_onchain_shares_raw, last_onchain_shares_raw, last_reconciled_at)
        VALUES (?, '100', '100', '100', ?)
      `
    ).run(tokenId, nowIso);
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      books: [liveBook(nowMs)],
      submitResults: {
        [signedOrderHash]: submitResult({ success: true, status: "matched" })
      },
      orderStatuses: {
        [signedOrderHash]: orderStatus("matched", [
          {
            tradeId: "trade-live-sell-1",
            fillHash: "fill-live-sell-1",
            pricePpm: 500_000,
            sizeRaw: "51",
            pUsdDeltaRaw: "25",
            feeRaw: "0",
            occurredAt: nowIso
          }
        ])
      }
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [owner])]: 1_000_000n,
        [contractReadKey(PUSD, "allowance", [owner, CTF_EXCHANGE_V2])]: 1_000_000n,
        [contractReadKey(CTF, "balanceOf", [owner, tokenId])]: [100n, 100n, 49n]
      }
    });

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: fixedSellSigner(),
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: true,
      balanceMismatchToleranceRaw: "0",
      maxPositionAgeMs: 300_000,
      nowMs,
      nowIso,
      signBoundary,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({ submitted: 1, reconciled: 1, rejected: 0, timeoutUnknown: 0, halted: false });
    expect(tempDb.db.prepare("SELECT inventory_reserved_raw, p_usd_reserved_raw, side FROM risk_reservations").get()).toEqual({
      inventory_reserved_raw: "51",
      p_usd_reserved_raw: "0",
      side: "SELL"
    });
    expect(orderSummary(tempDb, signedOrderHash)).toMatchObject({
      current_state: "ACK_FILLED",
      filled_size_raw: "51"
    });
  });

  it("rejects SDK-downsized SELL proceeds before outbox", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedSellDecision(tempDb.db);
    tempDb.db.prepare(
      `
        INSERT INTO positions (token_id, shares_raw, expected_onchain_shares_raw, last_onchain_shares_raw, last_reconciled_at)
        VALUES (?, '100', '100', '100', ?)
      `
    ).run(tokenId, nowIso);
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      books: [liveBook(nowMs)]
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(CTF, "balanceOf", [owner, tokenId])]: 100n
      }
    });

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: downsizedSellSigner({ takerAmount: "23" }),
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: true,
      balanceMismatchToleranceRaw: "0",
      maxPositionAgeMs: 300_000,
      nowMs,
      nowIso,
      signBoundary,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({ considered: 1, errors: 1, outboxed: 0, submitted: 0, rejected: 0 });
    expect(tempDb.db.prepare("SELECT status, error_reason FROM copy_decisions WHERE id = 'live-sell-decision'").get()).toEqual({
      status: "ERROR",
      error_reason: "SIGNED_SELL_PROCEEDS_BELOW_APPROVED_NOTIONAL: approvedNotionalRaw=25 signedTakerAmountRaw=23 sdkAdjustmentRaw=2"
    });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM order_submissions").get()).toEqual({ count: 0 });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM risk_reservations").get()).toEqual({ count: 0 });
  });

  it("skips before signing when sign-boundary re-gate finds a stale book", async () => {
    tempDb = await createMigratedTempDb();
    insertApprovedDecision(tempDb.db);
    const clock = new MockClock(nowMs);
    let signCalls = 0;
    const clob = new MockClobRestAdapter({
      clock,
      books: [liveBook(nowMs - 10_000)],
      balances: [collateralBalance("1000000", "1000000")]
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(PUSD, "balanceOf", [owner])]: 1_000_000n,
        [contractReadKey(PUSD, "allowance", [owner, CTF_EXCHANGE_V2])]: 1_000_000n
      }
    });

    const result = await runLiveTradingCycle(tempDb.db, {
      clob,
      signer: {
        async signMarketOrder() {
          signCalls += 1;
          return fixedSigner().signMarketOrder({
            tokenId,
            side: "BUY",
            approvedNotionalRaw: 25n,
            intendedSizeRaw: 50n,
            limitPricePpm: 500_000,
            orderType: "FAK",
            tickSize: "0.01",
            negRisk: false
          });
        }
      },
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxPendingSubmissions: 32,
      maxOneLiveOrder: true,
      balanceMismatchToleranceRaw: "0",
      nowMs,
      nowIso,
      signBoundary,
      killSwitchActive: () => false
    });

    expect(result).toMatchObject({ considered: 1, skipped: 1, submitted: 0, outboxed: 0 });
    expect(signCalls).toBe(0);
    expect(tempDb.db.prepare("SELECT status, skip_reason FROM copy_decisions WHERE id = 'live-decision'").get()).toEqual({
      status: "SKIPPED",
      skip_reason: "STALE_AT_SIGN"
    });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM order_submissions").get()).toEqual({ count: 0 });
  });
});

function insertApprovedSellDecision(db: TempDb["db"]): void {
  insertCopyDecision(db, {
    groupId: "live-sell-group",
    decisionId: "live-sell-decision",
    sourceWallet: leader,
    tokenId,
    side: "SELL",
    status: "ACTIVE"
  });
  db.prepare(
    `
      UPDATE copy_decisions
      SET contract_address = ?,
          approved_copy_notional_raw = '25',
          intended_copy_notional_raw = '25',
          gate_snapshot_json = ?
      WHERE id = 'live-sell-decision'
    `
  ).run(
    CTF_EXCHANGE_V2,
    JSON.stringify({
      leaderPricePpm: 500_000,
      limitPpm: 500_000,
      book: { intendedSizeRaw: "51", vwapPpm: 500_000 },
      metadata: { tickSize: "0.01", negRisk: false }
    })
  );
}

function insertApprovedDecision(db: TempDb["db"]): void {
  insertCopyDecision(db, {
    groupId: "live-group",
    decisionId: "live-decision",
    sourceWallet: leader,
    tokenId,
    side: "BUY",
    status: "ACTIVE"
  });
  db.prepare(
    `
      UPDATE copy_decisions
      SET contract_address = ?,
          approved_copy_notional_raw = '25',
          intended_copy_notional_raw = '25',
          gate_snapshot_json = ?
      WHERE id = 'live-decision'
    `
  ).run(
    CTF_EXCHANGE_V2,
    JSON.stringify({
      leaderPricePpm: 500_000,
      limitPpm: 500_000,
      book: { intendedSizeRaw: "50", vwapPpm: 500_000 },
      metadata: { tickSize: "0.01", negRisk: false }
    })
  );
}

function insertSecondApprovedDecision(db: TempDb["db"]): void {
  insertCopyDecision(db, {
    groupId: "live-group-2",
    decisionId: "live-decision-2",
    sourceWallet: leader,
    tokenId: "987654321",
    side: "BUY",
    status: "ACTIVE"
  });
  db.prepare(
    `
      UPDATE copy_decisions
      SET contract_address = ?,
          approved_copy_notional_raw = '25',
          intended_copy_notional_raw = '25',
          gate_snapshot_json = ?
      WHERE id = 'live-decision-2'
    `
  ).run(
    CTF_EXCHANGE_V2,
    JSON.stringify({
      leaderPricePpm: 500_000,
      limitPpm: 500_000,
      book: { intendedSizeRaw: "50", vwapPpm: 500_000 },
      metadata: { tickSize: "0.01", negRisk: false }
    })
  );
}

function liveBook(receivedAtMs: number) {
  return {
    tokenId,
    source: "REST" as const,
    receivedAtMs,
    asks: [{ pricePpm: 500_000, sizeRaw: "1000000" }],
    bids: [{ pricePpm: 490_000, sizeRaw: "1000000" }]
  };
}

function fixedSellSigner(): LiveOrderSigner {
  return {
    async signMarketOrder(args): Promise<SignedClobOrder> {
      return {
        orderHash: signedOrderHash,
        payload: {
          salt: "1",
          maker: owner,
          signer: owner,
          tokenId: args.tokenId,
          makerAmount: args.intendedSizeRaw.toString(),
          takerAmount: args.approvedNotionalRaw.toString(),
          side: "SELL",
          signatureType: 0,
          timestamp: "1779451200000",
          metadata: `0x${"0".repeat(64)}`,
          builder: `0x${"0".repeat(64)}`,
          expiration: "0",
          signature: `0x${"b".repeat(130)}`
        }
      };
    }
  };
}

function downsizedSellSigner(args: { makerAmount?: string; takerAmount: string }): LiveOrderSigner {
  return {
    async signMarketOrder(signArgs): Promise<SignedClobOrder> {
      return {
        orderHash: signedOrderHash,
        payload: {
          salt: "1",
          maker: owner,
          signer: owner,
          tokenId: signArgs.tokenId,
          makerAmount: args.makerAmount ?? signArgs.intendedSizeRaw.toString(),
          takerAmount: args.takerAmount,
          side: "SELL",
          signatureType: 0,
          timestamp: "1779451200000",
          metadata: `0x${"0".repeat(64)}`,
          builder: `0x${"0".repeat(64)}`,
          expiration: "0",
          signature: `0x${"b".repeat(130)}`
        }
      };
    }
  };
}

function fixedSigner(): LiveOrderSigner {
  return {
    async signMarketOrder(): Promise<SignedClobOrder> {
      return {
        orderHash: signedOrderHash,
        payload: {
          salt: "1",
          maker: owner,
          signer: owner,
          tokenId,
          makerAmount: "25",
          takerAmount: "50",
          side: "BUY",
          signatureType: 0,
          timestamp: "1779451200000",
          metadata: `0x${"0".repeat(64)}`,
          builder: `0x${"0".repeat(64)}`,
          expiration: "0",
          signature: `0x${"b".repeat(130)}`
        }
      };
    }
  };
}

function mutatedBuySigner(overrides: Record<string, string | number>): LiveOrderSigner {
  return {
    async signMarketOrder(): Promise<SignedClobOrder> {
      return {
        orderHash: signedOrderHash,
        payload: {
          salt: "1",
          maker: owner,
          signer: owner,
          tokenId,
          makerAmount: "25",
          takerAmount: "50",
          side: "BUY",
          signatureType: 0,
          timestamp: "1779451200000",
          metadata: `0x${"0".repeat(64)}`,
          builder: `0x${"0".repeat(64)}`,
          expiration: "0",
          signature: `0x${"b".repeat(130)}`,
          ...overrides
        }
      };
    }
  };
}

function downsizedBuySigner(makerAmount: string): LiveOrderSigner {
  return {
    async signMarketOrder(): Promise<SignedClobOrder> {
      return {
        orderHash: signedOrderHash,
        payload: {
          salt: "1",
          maker: owner,
          signer: owner,
          tokenId,
          makerAmount,
          takerAmount: "50",
          side: "BUY",
          signatureType: 0,
          timestamp: "1779451200000",
          metadata: `0x${"0".repeat(64)}`,
          builder: `0x${"0".repeat(64)}`,
          expiration: "0",
          signature: `0x${"b".repeat(130)}`
        }
      };
    }
  };
}

function collateralBalance(balanceRaw: string, allowanceRaw: string) {
  return {
    assetType: "COLLATERAL" as const,
    expectedFunder: owner,
    expectedSpender: CTF_EXCHANGE_V2,
    expectedSignatureType: 0 as const,
    balanceRaw,
    allowanceRaw,
    receivedAtMs: nowMs,
    raw: { fixture: true }
  };
}

function submitResult(overrides: Partial<SubmitResult>): SubmitResult {
  return {
    success: true,
    errorMsg: "",
    orderID: signedOrderHash,
    status: "matched",
    transactionsHashes: [],
    tradeIDs: [],
    raw: { fixture: true },
    ...overrides
  };
}

function orderStatus(status: OrderStatusResult["status"], fills: OrderStatusResult["fills"]): OrderStatusResult {
  return { status, fills, raw: { fixture: status } };
}

function orderSummary(tempDb: TempDb, hash: Hex): Record<string, unknown> {
  return tempDb.db
    .prepare(
      `
        SELECT current_state, filled_size_raw, abandoned_size_raw, encrypted_signed_payload_json, payload_erased_at
        FROM order_submissions
        WHERE signed_order_hash = ?
      `
    )
    .get(hash) as Record<string, unknown>;
}

function contractReadKey(address: Hex, functionName: string, args: unknown[]): string {
  return `${address.toLowerCase()}:${functionName}:${JSON.stringify(args, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  )}`;
}
