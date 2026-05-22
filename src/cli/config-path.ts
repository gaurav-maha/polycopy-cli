import type { Command } from "commander";
import { resolveConfigPath } from "../config/persist.js";

export function resolveCliConfigPath(program: Command, explicit?: string): string {
  const globalOptions = program.optsWithGlobals() as { config?: string };
  return resolveConfigPath(explicit ?? globalOptions.config ?? process.env.POLYCOPY_CONFIG);
}
