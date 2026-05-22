import type { Hex, SignedClobOrder } from "../../adapters/types.js";
import type { BuyFeeConfig } from "../../risk/fee-headroom.js";

export type LiveOrderSigner = {
  signMarketOrder(args: {
    tokenId: string;
    side: "BUY" | "SELL";
    approvedNotionalRaw: bigint;
    intendedSizeRaw: bigint;
    limitPricePpm: number;
    orderType: "FAK" | "FOK";
    tickSize: string;
    negRisk: boolean;
    userPusdBalanceRaw?: bigint;
  }): Promise<SignedClobOrder>;
};

export type LiveTradingCycleResult = {
  considered: number;
  outboxed: number;
  submitted: number;
  reconciled: number;
  rejected: number;
  timeoutUnknown: number;
  staleAtSign: number;
  cacheMismatch: number;
  bookSourceMismatch: number;
  clobUnavailable: number;
  skipped: number;
  errors: number;
  halted: boolean;
  haltReason: string | null;
  orderSubmissionIds: string[];
};

export type CopyDecisionRow = {
  id: string;
  source_wallet: Hex;
  token_id: string;
  side: "BUY" | "SELL";
  contract_address: Hex;
  approved_copy_notional_raw: string;
  intended_copy_notional_raw: string;
  gate_snapshot_json: string;
  created_at: string;
};

export type PreparedDecision = CopyDecisionRow & {
  approvedNotionalRaw: bigint;
  intendedSizeRaw: bigint;
  feeHeadroomRaw: bigint;
  feeConfig?: BuyFeeConfig;
  leaderPricePpm: number;
  tickSizePpm: number;
  limitPricePpm: number;
  tickSize: string;
  negRisk: boolean;
  orderType: "FAK" | "FOK";
};

export type BalanceGateSnapshot = {
  onchainPusdRaw: bigint;
  clobPusdRaw: bigint;
  allowanceRaw: bigint;
  requiredRaw: bigint;
};

export type SellInventoryGateSnapshot = {
  onchainSharesRaw: bigint;
  availableSharesRaw: bigint;
  activeReservedSharesRaw: bigint;
  requiredSharesRaw: bigint;
};
