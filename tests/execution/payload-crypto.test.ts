import { randomBytes } from "node:crypto";
import {
  decryptSignedPayload,
  encryptSignedPayload,
  parseEncryptedSignedPayload
} from "../../src/execution/payload-crypto.js";

describe("signed payload encryption", () => {
  it("round-trips the exact signed payload string without exposing plaintext", () => {
    const key = randomBytes(32);
    const signedPayload = JSON.stringify({
      signedOrderHash: `0x${"a".repeat(64)}`,
      makerAmount: "250000",
      signature: "super-secret-maker-signature"
    });

    const encrypted = encryptSignedPayload(signedPayload, key, { aad: "decision-1" });

    expect(encrypted).not.toContain("super-secret-maker-signature");
    expect(encrypted).not.toContain(`0x${"a".repeat(64)}`);
    expect(decryptSignedPayload(encrypted, key, { aad: "decision-1" })).toBe(signedPayload);
  });

  it("uses a fresh 96-bit nonce for each encryption", () => {
    const key = randomBytes(32);

    const first = parseEncryptedSignedPayload(encryptSignedPayload('{"payload":1}', key));
    const second = parseEncryptedSignedPayload(encryptSignedPayload('{"payload":1}', key));

    expect(Buffer.from(first.nonce, "base64")).toHaveLength(12);
    expect(Buffer.from(second.nonce, "base64")).toHaveLength(12);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("rejects modified ciphertext or mismatched authenticated data", () => {
    const key = randomBytes(32);
    const encrypted = encryptSignedPayload('{"signed":true}', key, { aad: "decision-1" });
    const envelope = parseEncryptedSignedPayload(encrypted);
    const tampered = JSON.stringify({ ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` });

    expect(() => decryptSignedPayload(tampered, key, { aad: "decision-1" })).toThrow(/authentication failed/i);
    expect(() => decryptSignedPayload(encrypted, key, { aad: "decision-2" })).toThrow(/authentication failed/i);
  });

  it("requires an AES-256 key", () => {
    expect(() => encryptSignedPayload("{}", randomBytes(31))).toThrow(/32-byte/);
    expect(() => decryptSignedPayload("{}", randomBytes(33))).toThrow(/32-byte/);
  });
});
