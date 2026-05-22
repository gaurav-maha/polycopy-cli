import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function runBin(args: string[], env: NodeJS.ProcessEnv): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [resolve("bin/polycopy.js"), ...args], {
    cwd: resolve("."),
    env: { ...process.env, ...env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const [exitCode] = (await once(child, "exit")) as [number | null];
  return { exitCode, stdout, stderr };
}

describe("dist entrypoint", () => {
  let dir: string;
  let rpcPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-dist-"));
    rpcPath = join(dir, "rpc.json");
    await runBin(["--json", "rpc", "add", "https://polygon.example/rpc"], { POLYCOPY_RPC_PATH: rpcPath });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads sqlite migrations from dist when running copytrade dry-run", async () => {
    const result = await runBin(
      [
        "--json",
        "copytrade",
        "0x1111111111111111111111111111111111111111",
        "--dry-run",
        "--duration-minutes",
        "0",
        "--max-iterations",
        "0",
        "--http-fallback"
      ],
      { POLYCOPY_RPC_PATH: rpcPath, POLYCOPY_DATA_DIR: join(dir, "data") }
    );

    expect(result.stdout + result.stderr).not.toMatch(/dist\/db\/schema/);
    expect(result.stdout + result.stderr).not.toMatch(/ENOENT.*schema/);
  });
});
