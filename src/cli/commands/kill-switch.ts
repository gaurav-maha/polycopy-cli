import { Command } from "commander";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function isActive(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function registerKillSwitch(program: Command): void {
  const killSwitch = program.command("kill-switch").description("Manage the live kill switch");
  killSwitch
    .command("status")
    .description("Show kill switch state")
    .option("--path <path>", "kill switch path", "./.polycopy/kill.switch")
    .action(async (options: { path: string }) => {
      process.stdout.write(`${JSON.stringify({ ok: true, active: await isActive(options.path), path: options.path })}\n`);
    });
  killSwitch
    .command("enable")
    .description("Enable kill switch")
    .option("--path <path>", "kill switch path", "./.polycopy/kill.switch")
    .action(async (options: { path: string }) => {
      await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
      await writeFile(options.path, `${new Date().toISOString()}\n`, { mode: 0o600 });
      process.stdout.write(`${JSON.stringify({ ok: true, active: true, path: options.path })}\n`);
    });
  killSwitch
    .command("disable")
    .description("Disable kill switch")
    .option("--path <path>", "kill switch path", "./.polycopy/kill.switch")
    .action(async (options: { path: string }) => {
      await rm(options.path, { force: true });
      process.stdout.write(`${JSON.stringify({ ok: true, active: false, path: options.path })}\n`);
    });
}
