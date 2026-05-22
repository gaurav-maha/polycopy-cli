export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeDeep<T>(base: T, overlay: unknown): T {
  if (!isRecord(base) || !isRecord(overlay)) {
    return overlay === undefined ? base : (overlay as T);
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = key in merged ? mergeDeep(merged[key], value) : value;
  }
  return merged as T;
}
