export function parseUsdAmountRaw(input: string): string {
  const trimmed = input.trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(trimmed)) {
    throw new Error("USD amount must be a non-negative decimal with up to 6 places");
  }
  const [whole, fractional = ""] = trimmed.split(".");
  return `${whole}${fractional.padEnd(6, "0")}`.replace(/^0+(?=\d)/, "");
}

export function normalizeCopyPct(input: string): string {
  const trimmed = input.trim();
  if (/^(0?(\.\d+)?|1(\.0+)?)$/.test(trimmed)) {
    return trimmed;
  }
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(trimmed)) {
    throw new Error("copy percentage must be a decimal fraction or percent");
  }
  const percent = Number(trimmed);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("copy percentage must be between 0 and 100");
  }
  const normalized = (percent / 100).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return /^0\.\d$/.test(normalized) ? `${normalized}0` : normalized;
}
