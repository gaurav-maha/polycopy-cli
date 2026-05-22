import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/client.js";
import { execaNode } from "../helpers/execa-node.js";

describe("offline demo replay", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-demo-"));
    dbPath = join(dir, "polycopy.db");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replays fixtures into SQLite copy decisions", async () => {
    const result = await execaNode([
      "--json",
      "demo",
      "--fixture",
      "all",
      "--db",
      dbPath,
      "--leader",
      "0x1111111111111111111111111111111111111111"
    ]);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.summary.decisions).toBeGreaterThanOrEqual(8);
    expect(payload.summary.approved).toBeGreaterThanOrEqual(1);
    expect(payload.summary.skipped).toBeGreaterThanOrEqual(1);

    const db = openDatabase(dbPath);
    try {
      const decisions = db.prepare("SELECT status, skip_reason FROM copy_decisions").all();
      expect(decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "ACTIVE", skip_reason: null }),
          expect.objectContaining({ status: "SKIPPED", skip_reason: "SIDE_DISABLED" })
        ])
      );
    } finally {
      db.close();
    }
  });
});
