import { AccountConfig, accountConfigSchema } from "../config/schema.js";

export type AccountValidationResult = { ok: true } | { ok: false; errors: string[] };

export function validateAccountConfig(account: AccountConfig): AccountValidationResult {
  const parsed = accountConfigSchema.safeParse(account);
  if (parsed.success) {
    return { ok: true };
  }
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => issue.message)
  };
}

export function assertLiveWalletModeSupported(account: AccountConfig): void {
  const validation = validateAccountConfig(account);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }

  if (account.walletMode === "EOA") {
    throw new Error(
      "EOA live order submission is not supported by the Polymarket CLOB deposit-wallet flow; configure POLY_1271 or POLY_PROXY and fund/approve that wallet"
    );
  }

  const requiredFields = [
    "ownerSignerAddress",
    "orderMakerAddress",
    "orderSignerAddress",
    "funderAddress"
  ] as const;
  const missingFields = requiredFields.filter((field) => !account[field]);
  if (missingFields.length > 0) {
    throw new Error(`live order submission requires account addresses: missing ${missingFields.join(", ")}`);
  }
}
