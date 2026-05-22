import { planQueueOverflowCleanup } from "../../src/execution/queue.js";

describe("submission queue overflow planning", () => {
  it("cancels only the oldest CREATED rows and preserves uncertain/submitted rows", () => {
    const plan = planQueueOverflowCleanup(
      [
        row("submitting-old", "decision-submitting", "SUBMITTING", "2026-05-22T10:00:00.000Z"),
        row("timeout-old", "decision-timeout", "TIMEOUT_UNKNOWN", "2026-05-22T10:01:00.000Z"),
        row("submitted-old", "decision-submitted", "SUBMITTED", "2026-05-22T10:02:00.000Z"),
        row("created-oldest", "decision-created-oldest", "CREATED", "2026-05-22T10:03:00.000Z"),
        row("created-newest", "decision-created-newest", "CREATED", "2026-05-22T10:04:00.000Z"),
        row("created-middle", "decision-created-middle", "CREATED", "2026-05-22T10:03:30.000Z")
      ],
      { maxPendingSubmissions: 4, incomingSubmissions: 1 }
    );

    expect(plan.overflow).toBe(true);
    expect(plan.cleanupActions.map((action) => action.orderSubmissionId)).toEqual(["created-oldest", "created-middle", "created-newest"]);
    expect(plan.cleanupActions.every((action) => action.transition.from === "CREATED" && action.transition.to === "CANCELLED")).toBe(true);
    expect(plan.cleanupActions.every((action) => action.decision.skipReason === "QUEUE_OVERFLOW")).toBe(true);
    expect(plan.cleanupActions.every((action) => action.releaseReservation && action.erasePayload && !action.deleteRow)).toBe(true);
    expect(plan.cleanupActions.map((action) => action.orderSubmissionId)).not.toContain("submitting-old");
    expect(plan.cleanupActions.map((action) => action.orderSubmissionId)).not.toContain("submitted-old");
    expect(plan.cleanupActions.map((action) => action.orderSubmissionId)).not.toContain("timeout-old");
    expect(plan.currentDecisionSkip).toEqual({ status: "SKIPPED", skipReason: "QUEUE_OVERFLOW" });
    expect(plan.circuitBreaker).toBe("QUEUE_OVERFLOW");
  });

  it("cancels no more than the overflow count", () => {
    const plan = planQueueOverflowCleanup(
      [
        row("created-1", "decision-1", "CREATED", "2026-05-22T10:00:00.000Z"),
        row("created-2", "decision-2", "CREATED", "2026-05-22T10:01:00.000Z"),
        row("created-3", "decision-3", "CREATED", "2026-05-22T10:02:00.000Z"),
        row("submitting-1", "decision-4", "SUBMITTING", "2026-05-22T10:03:00.000Z")
      ],
      { maxPendingSubmissions: 3, incomingSubmissions: 1 }
    );

    expect(plan.cleanupActions.map((action) => action.orderSubmissionId)).toEqual(["created-1", "created-2"]);
  });
});

function row(id: string, copyDecisionId: string, currentState: string, createdAt: string) {
  return {
    id,
    copyDecisionId,
    currentState,
    createdAt,
    intendedSizeRaw: "1000"
  };
}
