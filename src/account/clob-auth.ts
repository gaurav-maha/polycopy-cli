import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { Chain, ClobClient, type ApiKeyCreds } from "@polymarket/clob-client-v2";

export async function createOrDeriveClobCredentials(args: {
  privateKey: Hex;
  rpcUrl: string;
}): Promise<ApiKeyCreds> {
  const account = privateKeyToAccount(args.privateKey);
  const signer = createWalletClient({ account, chain: polygon, transport: http(args.rpcUrl) });
  const client = new ClobClient({
    host: "https://clob.polymarket.com",
    chain: Chain.POLYGON,
    signer: signer as never
  });
  const credentials = await client.createOrDeriveApiKey();
  const key = credentials.key ?? (credentials as { apiKey?: string }).apiKey;
  if (!key || !credentials.secret || !credentials.passphrase) {
    throw new Error("CLOB credential response missing key, secret, or passphrase");
  }
  return { key, secret: credentials.secret, passphrase: credentials.passphrase };
}

export function readClobCredentials(values: Record<string, string>): ApiKeyCreds | null {
  const key = values.CLOB_API_KEY?.trim();
  const secret = values.CLOB_SECRET?.trim();
  const passphrase = (values.CLOB_PASS_PHRASE ?? values.CLOB_PASSPHRASE)?.trim();
  if (!key && !secret && !passphrase) return null;
  if (!key || !secret || !passphrase) {
    throw new Error("wallet file has incomplete CLOB credentials");
  }
  return { key, secret, passphrase };
}
