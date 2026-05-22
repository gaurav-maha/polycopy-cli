import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const SENSITIVE_KEY_PATTERNS = [
  /^private_key$/i,
  /^clob_api_key$/i,
  /^clob_secret$/i,
  /^clob_pass_phrase$/i,
  /^clob_passphrase$/i,
  /^authorization$/i,
  /^auth$/i,
  /^signature$/i,
  /^signedorder$/i,
  /^signed_order$/i,
  /^payload$/i,
  /^encrypted_signed_payload_json$/i
];

function shouldRedact(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function redact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry)) as T;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = shouldRedact(key) ? "[REDACTED]" : redact(nested);
    }
    return output as T;
  }
  return value;
}

export async function writeJsonl(path: string, event: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(redact({ ...event, ts: new Date().toISOString() }))}\n`, {
    mode: 0o600
  });
}
