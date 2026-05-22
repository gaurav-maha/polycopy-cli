import { getAddress } from "viem";
import type { AccountConfig } from "./schema.js";
import { hexAddressSchema } from "./schema.js";

export type HexAddress = `0x${string}`;

export function normalizeAccountAddress(address: string): HexAddress {
  return getAddress(hexAddressSchema.parse(address)) as HexAddress;
}

/** Set all EOA account roles to one wallet address. */
export function applyEoaWallet(account: AccountConfig, wallet: string): AccountConfig {
  const address = normalizeAccountAddress(wallet);
  return {
    ...account,
    walletMode: "EOA",
    signatureType: 0,
    ownerSignerAddress: address,
    orderMakerAddress: address,
    orderSignerAddress: address,
    funderAddress: address
  };
}

/** Set POLY_PROXY roles: owner EOA signs; proxy wallet is maker/funder. */
export function applyPolyProxyWallet(account: AccountConfig, args: { owner: string; proxy: string }): AccountConfig {
  const owner = normalizeAccountAddress(args.owner);
  const proxy = normalizeAccountAddress(args.proxy);
  return {
    ...account,
    walletMode: "POLY_PROXY",
    signatureType: 1,
    ownerSignerAddress: owner,
    orderSignerAddress: owner,
    orderMakerAddress: proxy,
    funderAddress: proxy
  };
}

/** Set POLY_1271 roles: contract wallet is maker/signer/funder; owner signs setup txs. */
export function applyPoly1271Wallet(account: AccountConfig, args: { owner: string; contract: string }): AccountConfig {
  const owner = normalizeAccountAddress(args.owner);
  const contract = normalizeAccountAddress(args.contract);
  return {
    ...account,
    walletMode: "POLY_1271",
    signatureType: 3,
    ownerSignerAddress: owner,
    orderMakerAddress: contract,
    orderSignerAddress: contract,
    funderAddress: contract
  };
}

/** Update the local owner signer without discarding an already configured Polymarket wallet. */
export function applyOwnerSignerWallet(account: AccountConfig, wallet: string): AccountConfig {
  if (account.walletMode === "POLY_PROXY") {
    const proxy = account.orderMakerAddress ?? account.funderAddress;
    if (!proxy) {
      throw new Error("wallet use cannot preserve POLY_PROXY without a configured proxy address");
    }
    return applyPolyProxyWallet(account, { owner: wallet, proxy });
  }

  if (account.walletMode === "POLY_1271") {
    const contract = account.orderMakerAddress ?? account.orderSignerAddress ?? account.funderAddress;
    if (!contract) {
      throw new Error("wallet use cannot preserve POLY_1271 without a configured deposit wallet address");
    }
    return applyPoly1271Wallet(account, { owner: wallet, contract });
  }

  return applyEoaWallet(account, wallet);
}
