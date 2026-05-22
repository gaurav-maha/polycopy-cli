export function applyDecimalPct(raw: string, pct: string): bigint {
  const value = BigInt(raw);
  const [whole, fraction = ""] = pct.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole || "0") * scale + BigInt(fraction || "0");
  return (value * numerator) / scale;
}

export function minBigint(values: bigint[]): bigint {
  return values.reduce((min, value) => (value < min ? value : min));
}
