import { parseAbiItem, keccak256, toBytes } from "viem";
import { CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2 } from "./chain.js";

export { CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2 };

export const ORDER_TYPEHASH = "0xbb86318a2138f5fa8ae32fbe8e659f8fcf13cc6ae4014a707893055433818589" as const;

export const ORDER_FILLED_SIGNATURE =
  "OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32)" as const;

export const ORDER_FILLED_TOPIC = keccak256(toBytes(ORDER_FILLED_SIGNATURE));

export const ORDER_FILLED_EVENT_ABI = parseAbiItem(
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)"
);
