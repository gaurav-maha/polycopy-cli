import type { Config } from "./schema.js";

export function resolveSecretsPath(args: { explicit?: string; config?: Config; env?: NodeJS.ProcessEnv }): string {
  const env = args.env ?? process.env;
  return args.explicit ?? env.POLYCOPY_SECRETS ?? args.config?.runtime.secretsPath ?? ".env";
}
