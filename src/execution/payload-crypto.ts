import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const nonceBytes = 12;
const authTagBytes = 16;
const keyBytes = 32;

export type EncryptedSignedPayload = {
  version: 1;
  alg: "AES-256-GCM";
  nonce: string;
  ciphertext: string;
  authTag: string;
};

export type SignedPayloadCryptoOptions = {
  aad?: string | Uint8Array;
};

export function encryptSignedPayload(payloadUtf8: string, key: Uint8Array, options: SignedPayloadCryptoOptions = {}): string {
  assertAes256Key(key);
  const nonce = randomBytes(nonceBytes);
  const cipher = createCipheriv(algorithm, key, nonce, { authTagLength: authTagBytes });
  if (options.aad !== undefined) {
    cipher.setAAD(toBuffer(options.aad));
  }

  const ciphertext = Buffer.concat([cipher.update(payloadUtf8, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    version: 1,
    alg: "AES-256-GCM",
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: authTag.toString("base64")
  } satisfies EncryptedSignedPayload);
}

export function decryptSignedPayload(encryptedPayloadJson: string, key: Uint8Array, options: SignedPayloadCryptoOptions = {}): string {
  assertAes256Key(key);
  const envelope = parseEncryptedSignedPayload(encryptedPayloadJson);

  try {
    const decipher = createDecipheriv(algorithm, key, Buffer.from(envelope.nonce, "base64"), {
      authTagLength: authTagBytes
    });
    if (options.aad !== undefined) {
      decipher.setAAD(toBuffer(options.aad));
    }
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch (error) {
    throw new Error("Signed payload authentication failed", { cause: error });
  }
}

export function parseEncryptedSignedPayload(encryptedPayloadJson: string): EncryptedSignedPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encryptedPayloadJson);
  } catch (error) {
    throw new Error("Encrypted signed payload must be valid JSON", { cause: error });
  }

  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    parsed.alg !== "AES-256-GCM" ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.ciphertext !== "string" ||
    typeof parsed.authTag !== "string"
  ) {
    throw new Error("Encrypted signed payload envelope is invalid");
  }

  const envelope = parsed as EncryptedSignedPayload;
  if (Buffer.from(envelope.nonce, "base64").length !== nonceBytes) {
    throw new Error("Encrypted signed payload nonce must be 96 bits");
  }
  if (Buffer.from(envelope.authTag, "base64").length !== authTagBytes) {
    throw new Error("Encrypted signed payload auth tag is invalid");
  }
  return envelope;
}

function assertAes256Key(key: Uint8Array): void {
  if (key.byteLength !== keyBytes) {
    throw new Error("AES-256-GCM signed payload encryption requires a 32-byte key");
  }
}

function toBuffer(value: string | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
