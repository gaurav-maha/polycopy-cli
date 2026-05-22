import { accountFromPrivateKey, buildConfig, type BuildConfigArgs } from "./build.js";
import type { Config } from "./schema.js";
import type { HexAddress } from "./leaders.js";

export type CopytradeConfigArgs = Omit<
  BuildConfigArgs,
  "command" | "configPath" | "env"
> & {
  leaders: HexAddress[];
  rpcUrls: string[];
};

export { accountFromPrivateKey };

export async function buildCopytradeConfig(args: CopytradeConfigArgs): Promise<Config> {
  return buildConfig({ command: "copytrade", ...args });
}
