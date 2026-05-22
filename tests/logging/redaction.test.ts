import { redact } from "../../src/logging/jsonl.js";

describe("JSONL redaction", () => {
  it("redacts configured secrets and signed payload material", () => {
    const redacted = redact({
      PRIVATE_KEY: "0xabc",
      CLOB_API_KEY: "key",
      CLOB_SECRET: "secret",
      CLOB_PASS_PHRASE: "phrase",
      CLOB_PASSPHRASE: "alias",
      authorization: "Bearer token",
      encrypted_signed_payload_json: "cipher",
      nested: {
        signedOrder: {
          signature: "sig"
        }
      }
    });

    expect(JSON.stringify(redacted)).not.toContain("0xabc");
    expect(JSON.stringify(redacted)).not.toContain("secret");
    expect(redacted).toMatchObject({
      PRIVATE_KEY: "[REDACTED]",
      CLOB_API_KEY: "[REDACTED]",
      CLOB_SECRET: "[REDACTED]",
      CLOB_PASS_PHRASE: "[REDACTED]",
      CLOB_PASSPHRASE: "[REDACTED]",
      authorization: "[REDACTED]",
      encrypted_signed_payload_json: "[REDACTED]"
    });
  });
});
