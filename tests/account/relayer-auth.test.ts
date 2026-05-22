import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRelayerApiKeyWithGammaAuth } from "../../src/account/relayer-auth.js";

describe("relayer auth", () => {
  it("creates a relayer API key through Gamma SIWE auth without returning the Gamma token", async () => {
    const privateKey = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
    const account = privateKeyToAccount(privateKey);
    const calls: Array<{ path: string; method: string; cookie?: string }> = [];

    const fetchFn: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      calls.push({ path: url.pathname, method: init.method ?? "GET", cookie: headers.get("Cookie") ?? undefined });

      if (url.pathname === "/nonce") {
        return json({ nonce: "abcdefgh" }, { "Set-Cookie": "gamma_nonce=one; Path=/" });
      }

      if (url.pathname === "/login") {
        expect(headers.get("Cookie")).toContain("gamma_nonce=one");
        const encoded = headers.get("Authorization")?.replace(/^Bearer /, "");
        expect(encoded).toBeTruthy();
        const [fieldsJson, signature] = Buffer.from(encoded!, "base64").toString("utf8").split(":::");
        const fields = JSON.parse(fieldsJson!);
        expect(fields).toMatchObject({
          domain: "polymarket.com",
          address: account.address,
          statement: "Welcome to Polymarket! Sign to connect.",
          uri: "https://polymarket.com",
          version: "1",
          chainId: 137,
          nonce: "abcdefgh",
          issuedAt: "2026-01-01T00:00:00.000Z",
          expirationTime: "2026-01-08T00:00:00.000Z"
        });
        const message =
          `polymarket.com wants you to sign in with your Ethereum account:\n${account.address}\n\n` +
          "Welcome to Polymarket! Sign to connect.\n\n" +
          "URI: https://polymarket.com\n" +
          "Version: 1\n" +
          "Chain ID: 137\n" +
          "Nonce: abcdefgh\n" +
          "Issued At: 2026-01-01T00:00:00.000Z\n" +
          "Expiration Time: 2026-01-08T00:00:00.000Z";
        await expect(verifyMessage({ address: account.address, message, signature: signature as `0x${string}` })).resolves.toBe(true);
        return json({ type: "eoa", address: account.address }, { "Set-Cookie": "gamma_session=two; Path=/" });
      }

      if (url.pathname === "/relayer/api/auth") {
        expect(init.method).toBe("POST");
        expect(headers.get("Cookie")).toContain("gamma_nonce=one");
        expect(headers.get("Cookie")).toContain("gamma_session=two");
        return json({ apiKey: "relayer-key", address: account.address, createdAt: "now" });
      }

      throw new Error(`unexpected request: ${url.pathname}`);
    };

    const key = await createRelayerApiKeyWithGammaAuth({
      privateKey,
      fetchFn,
      nowMs: Date.parse("2026-01-01T00:00:00.000Z")
    });

    expect(key).toEqual({ apiKey: "relayer-key", address: account.address, createdAt: "now", updatedAt: undefined });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /nonce",
      "GET /login",
      "POST /relayer/api/auth"
    ]);
  });
});

function json(value: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers }
  });
}
