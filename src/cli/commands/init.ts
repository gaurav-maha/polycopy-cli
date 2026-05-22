import { Command } from "commander";
import { createDefaultConfig } from "../../config/persist.js";
import { resolveCliConfigPath } from "../config-path.js";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Create a local polycopy config")
    .action(async () => {
      const path = resolveCliConfigPath(program);
      await createDefaultConfig(path);
      const payload = { ok: true, path };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    });
}
