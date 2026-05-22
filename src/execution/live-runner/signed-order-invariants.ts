import type { Hex, SignedClobOrder } from "../../adapters/types.js";
import { readRecord, readString } from "./gate-snapshot.js";

const zeroBytes32 = `0x${"0".repeat(64)}`;

export type SignedOrderDecisionInvariant = {
  tokenId: string;
  side: "BUY" | "SELL";
  approvedNotionalRaw: bigint;
  intendedSizeRaw: bigint;
  limitPricePpm: number;
};

export type SignedOrderAccountInvariant = {
  expectedMaker: Hex;
  expectedSigner: Hex;
  expectedSignatureType: 0 | 1 | 3;
};

export type SignedOrderAmounts = {
  makerAmount: bigint;
  takerAmount: bigint;
};

export function expectedOrderSigner(args: {
  owner: Hex;
  funder: Hex;
  signatureType: 0 | 1 | 3;
}): Hex {
  return args.signatureType === 3 ? args.funder : args.owner;
}

export function assertSignedOrderInvariants(
  decision: SignedOrderDecisionInvariant,
  account: SignedOrderAccountInvariant,
  signedOrder: SignedClobOrder
): SignedOrderAmounts {
  const payload = readRecord(signedOrder.payload, "signed order payload");
  if (readString(payload.builder ?? zeroBytes32, "signed order builder") !== zeroBytes32) {
    throw new Error("signed order builder field must be zero");
  }
  if (readString(payload.tokenId, "signed order tokenId") !== decision.tokenId) {
    throw new Error("signed order tokenId does not match decision");
  }
  if (readString(payload.side, "signed order side") !== decision.side) {
    throw new Error("signed order side does not match decision");
  }

  const signatureType = Number(payload.signatureType);
  if (signatureType !== account.expectedSignatureType) {
    throw new Error(
      [
        "SIGNED_ORDER_SIGNATURE_TYPE_MISMATCH:",
        `expectedSignatureType=${account.expectedSignatureType}`,
        `signedSignatureType=${Number.isFinite(signatureType) ? signatureType.toString() : String(payload.signatureType)}`
      ].join(" ")
    );
  }

  const maker = readString(payload.maker, "signed order maker") as Hex;
  if (maker.toLowerCase() !== account.expectedMaker.toLowerCase()) {
    throw new Error(
      [
        "SIGNED_ORDER_MAKER_MISMATCH:",
        `expectedMaker=${account.expectedMaker}`,
        `signedMaker=${maker}`
      ].join(" ")
    );
  }

  const signer = readString(payload.signer, "signed order signer") as Hex;
  if (signer.toLowerCase() !== account.expectedSigner.toLowerCase()) {
    throw new Error(
      [
        "SIGNED_ORDER_SIGNER_MISMATCH:",
        `expectedSigner=${account.expectedSigner}`,
        `signedSigner=${signer}`
      ].join(" ")
    );
  }

  const makerAmount = BigInt(readString(payload.makerAmount, "signed order makerAmount"));
  const takerAmount = BigInt(readString(payload.takerAmount, "signed order takerAmount"));
  if (decision.side === "BUY") {
    if (makerAmount < decision.approvedNotionalRaw) {
      throw new Error(
        [
          "INSUFFICIENT_PUSD_FEE_HEADROOM:",
          `approvedNotionalRaw=${decision.approvedNotionalRaw.toString()}`,
          `signedMakerAmountRaw=${makerAmount.toString()}`,
          `sdkAdjustmentRaw=${(decision.approvedNotionalRaw - makerAmount).toString()}`
        ].join(" ")
      );
    }
    if (makerAmount > decision.approvedNotionalRaw) {
      throw new Error(
        [
          "SIGNED_BUY_EXCEEDS_APPROVED_NOTIONAL:",
          `approvedNotionalRaw=${decision.approvedNotionalRaw.toString()}`,
          `signedMakerAmountRaw=${makerAmount.toString()}`
        ].join(" ")
      );
    }
    if (!signedBuyPriceWithinLimit({ makerAmount, takerAmount, limitPricePpm: decision.limitPricePpm })) {
      throw new Error(
        [
          "SIGNED_BUY_PRICE_ABOVE_LIMIT:",
          `limitPricePpm=${decision.limitPricePpm.toString()}`,
          `signedMakerAmountRaw=${makerAmount.toString()}`,
          `signedTakerAmountRaw=${takerAmount.toString()}`
        ].join(" ")
      );
    }
    return { makerAmount, takerAmount };
  }

  if (makerAmount !== decision.intendedSizeRaw) {
    throw new Error(
      [
        "SIGNED_SELL_SIZE_MISMATCH:",
        `intendedSizeRaw=${decision.intendedSizeRaw.toString()}`,
        `signedMakerAmountRaw=${makerAmount.toString()}`
      ].join(" ")
    );
  }
  if (takerAmount < decision.approvedNotionalRaw) {
    throw new Error(
      [
        "SIGNED_SELL_PROCEEDS_BELOW_APPROVED_NOTIONAL:",
        `approvedNotionalRaw=${decision.approvedNotionalRaw.toString()}`,
        `signedTakerAmountRaw=${takerAmount.toString()}`,
        `sdkAdjustmentRaw=${(decision.approvedNotionalRaw - takerAmount).toString()}`
      ].join(" ")
    );
  }
  if (takerAmount > decision.approvedNotionalRaw) {
    throw new Error(
      [
        "SIGNED_SELL_PROCEEDS_EXCEED_APPROVED_NOTIONAL:",
        `approvedNotionalRaw=${decision.approvedNotionalRaw.toString()}`,
        `signedTakerAmountRaw=${takerAmount.toString()}`
      ].join(" ")
    );
  }
  return { makerAmount, takerAmount };
}

export function signedOrderInvariantErrorReason(error: unknown, fallbackPrefix: string): string {
  const message = stringifyError(error);
  return hasSignedOrderInvariantCode(message) ? message : `${fallbackPrefix}: ${message}`;
}

export function hasSignedOrderInvariantCode(message: string): boolean {
  return (
    message.startsWith("INSUFFICIENT_PUSD_FEE_HEADROOM:") ||
    message.startsWith("SIGNED_BUY_EXCEEDS_APPROVED_NOTIONAL:") ||
    message.startsWith("SIGNED_BUY_PRICE_ABOVE_LIMIT:") ||
    message.startsWith("SIGNED_BUY_SIZE_MISMATCH:") ||
    message.startsWith("SIGNED_SELL_SIZE_MISMATCH:") ||
    message.startsWith("SIGNED_SELL_PROCEEDS_BELOW_APPROVED_NOTIONAL:") ||
    message.startsWith("SIGNED_SELL_PROCEEDS_EXCEED_APPROVED_NOTIONAL:") ||
    message.startsWith("SIGNED_ORDER_SIGNATURE_TYPE_MISMATCH:") ||
    message.startsWith("SIGNED_ORDER_MAKER_MISMATCH:") ||
    message.startsWith("SIGNED_ORDER_SIGNER_MISMATCH:")
  );
}

function signedBuyPriceWithinLimit(args: { makerAmount: bigint; takerAmount: bigint; limitPricePpm: number }): boolean {
  if (args.makerAmount <= 0n || args.takerAmount <= 0n) return false;
  const minimumTakerAtLimit = (args.makerAmount * 1_000_000n) / BigInt(args.limitPricePpm);
  const rawShareRoundingTolerance = minimumTakerAtLimit > 10_000n ? 10_000n : 0n;
  return args.takerAmount + rawShareRoundingTolerance >= minimumTakerAtLimit;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
