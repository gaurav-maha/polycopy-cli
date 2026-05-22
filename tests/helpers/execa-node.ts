import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

type Result = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export async function execaNode(
  args: string[],
  options: { reject?: boolean; env?: NodeJS.ProcessEnv; configPath?: string; rpcPath?: string } = {}
): Promise<Result> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, NO_COLOR: "1" };
  if (options.configPath) {
    env.POLYCOPY_CONFIG = options.configPath;
  }
  if (options.rpcPath) {
    env.POLYCOPY_RPC_PATH = options.rpcPath;
  }
  const child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli/index.ts"), ...args], {
    cwd: resolve("."),
    env,
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
  const result = { exitCode, stdout, stderr };
  if (options.reject !== false && exitCode !== 0) {
    throw new Error(`Command failed (${exitCode})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
  return result;
}
