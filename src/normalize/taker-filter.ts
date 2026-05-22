import { getAddress, isAddressEqual } from "viem";
import { DecodedOrderFilled } from "../protocol/decode-order-filled.js";
import { deriveEconomics, LeaderRole, NormalizedEconomics } from "./side-math.js";

export type SourceNormalization =
  | ({
      accepted: true;
      sourceWallet: `0x${string}`;
      leaderRole: LeaderRole;
      skipReason: null;
    } & DecodedOrderFilled &
      NormalizedEconomics)
  | {
      accepted: false;
      skipReason: "MAKER_SIDE" | "ROLE_AMBIGUOUS" | "ERROR";
      sourceWallet?: `0x${string}`;
      errorReason?: string;
    };

export function normalizeSourceFill(
  fill: DecodedOrderFilled,
  args: { sourceWallets: readonly `0x${string}`[]; exchangeAddresses: readonly `0x${string}`[] }
): SourceNormalization {
  const walletSet = new Set(args.sourceWallets.map((wallet) => getAddress(wallet).toLowerCase()));
  const makerAddress = getAddress(fill.maker);
  const makerIsSource = walletSet.has(makerAddress.toLowerCase());
  const takerIsExchange = args.exchangeAddresses.some((address) => isAddressEqual(fill.taker, address));
  const takerIsSource = walletSet.has(getAddress(fill.taker).toLowerCase());
  const sourceWallet = makerIsSource ? makerAddress : takerIsSource ? (getAddress(fill.taker) as `0x${string}`) : undefined;

  if (fill.tokenId === "0") {
    return { accepted: false, skipReason: "ERROR", sourceWallet, errorReason: "INVALID_TOKEN_ID" };
  }

  if (makerIsSource && takerIsSource) {
    return { accepted: false, skipReason: "ROLE_AMBIGUOUS" };
  }

  if (makerIsSource && !takerIsSource) {
    return {
      ...fill,
      ...deriveEconomics(fill, "MAKER"),
      accepted: true,
      sourceWallet: makerAddress,
      leaderRole: "MAKER",
      skipReason: null
    };
  }
  if (takerIsSource && !takerIsExchange) {
    return {
      ...fill,
      ...deriveEconomics(fill, "TAKER"),
      accepted: true,
      sourceWallet: getAddress(fill.taker) as `0x${string}`,
      leaderRole: "TAKER",
      skipReason: null
    };
  }
  return { accepted: false, skipReason: "ROLE_AMBIGUOUS", sourceWallet };
}
