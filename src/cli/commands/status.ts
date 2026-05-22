import { Command } from "commander";
import { listRows } from "../db-output.js";

interface RuntimeStateRow {
  key: string;
  value: string;
  updated_at: string;
}

interface ReconciliationDivergenceSummary {
  runId?: string;
  status?: string;
  divergences: number;
  at?: string;
}

interface LiveHaltSummary {
  halted: boolean;
  reasons: string[];
  reconciliationDivergence: ReconciliationDivergenceSummary | null;
  reorgOrphan: boolean;
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Print runtime status")
    .option("--db <path>", "SQLite DB path", "./.polycopy/polycopy.db")
    .action((options: { db: string }) => {
      const runtimeState = listRows(
        options.db,
        "SELECT key, value, updated_at FROM runtime_state ORDER BY key"
      ) as RuntimeStateRow[];
      const liveHalt = buildLiveHaltSummary(runtimeState);
      process.stdout.write(`${JSON.stringify({ ok: true, runtimeState, liveHalt })}\n`);
    });
}

function buildLiveHaltSummary(runtimeState: RuntimeStateRow[]): LiveHaltSummary {
  const reconciliationRow = runtimeState.find(
    (row) => row.key === "live_halt_reconciliation_divergence" || row.key === "live_halt.RECONCILIATION_DIVERGENCE"
  );
  const reorgOrphanRow = runtimeState.find((row) => row.key === "live_halt_reorg_orphan");
  const reconciliationDivergence = reconciliationRow
    ? summarizeReconciliationDivergence(reconciliationRow.value)
    : null;
  const reorgOrphan = reorgOrphanRow ? isTruthyRuntimeStateValue(reorgOrphanRow.value) : false;
  const reasons: string[] = [];

  if (reconciliationDivergence) {
    reasons.push("reconciliation_divergence");
  }
  if (reorgOrphan) {
    reasons.push("reorg_orphan");
  }

  return {
    halted: reasons.length > 0,
    reasons,
    reconciliationDivergence,
    reorgOrphan
  };
}

function summarizeReconciliationDivergence(value: string): ReconciliationDivergenceSummary {
  const parsed = parseJsonObject(value);
  if (!parsed) {
    return { divergences: 0 };
  }

  return {
    runId: readStringField(parsed, "runId"),
    status: readStringField(parsed, "status"),
    divergences: Array.isArray(parsed.divergences) ? parsed.divergences.length : 0,
    at: readStringField(parsed, "at")
  };
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isTruthyRuntimeStateValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "null";
}
