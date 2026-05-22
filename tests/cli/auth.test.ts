import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaNode } from "../helpers/execa-node.js";

describe("auth CLI", () => {
  let dir: string;
  let configPath: string;
  let walletFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-auth-"));
    configPath = join(dir, "config.json");
    walletFile = join(dir, "wallet.env");
    await execaNode(["--json", "init"], { configPath });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects incomplete existing CLOB credentials instead of treating auth as initialized", async () => {
    await writeFile(
      walletFile,
      [
        "PRIVATE_KEY=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "CLOB_API_KEY=partial-key"
      ].join("\n"),
      { mode: 0o600 }
    );
    await execaNode(["--json", "wallet", "use", walletFile], { configPath });

    const result = await execaNode(["--json", "auth", "init"], { configPath, reject: false });

    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ ok: false, command: "auth init", error: "AUTH_INIT_FAILED" });
    expect(payload.reason).toMatch(/incomplete CLOB credentials/i);
  });
});
