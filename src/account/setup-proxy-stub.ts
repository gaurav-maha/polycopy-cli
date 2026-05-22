import type { AccountConfig } from "../config/schema.js";

export class UnsupportedSetupExecutionError extends Error {
  readonly code = "UNSUPPORTED_SETUP_EXECUTION";
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "UnsupportedSetupExecutionError";
    this.reason = reason;
  }
}

export function unsupportedNonEoaExecuteReason(account: AccountConfig): string | null {
  if (account.walletMode === "EOA" || account.walletMode === "POLY_1271") {
    return null;
  }
  return `${account.walletMode} setup-account --execute is unsupported until legacy proxy wallet execution is implemented`;
}
