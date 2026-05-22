import { applyEoaWallet, applyPoly1271Wallet, applyPolyProxyWallet } from "../../src/config/account-set.js";

describe("account config set helpers", () => {
  const base = {
    walletMode: "EOA" as const,
    signatureType: 0 as const
  };

  it("fills all EOA account roles from one wallet", () => {
    const wallet = "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344";
    expect(applyEoaWallet(base, wallet)).toEqual({
      walletMode: "EOA",
      signatureType: 0,
      ownerSignerAddress: wallet,
      orderMakerAddress: wallet,
      orderSignerAddress: wallet,
      funderAddress: wallet
    });
  });

  it("maps POLY_PROXY owner and proxy roles", () => {
    const owner = "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344";
    const proxy = "0x1111111111111111111111111111111111111111";
    expect(applyPolyProxyWallet(base, { owner, proxy })).toEqual({
      walletMode: "POLY_PROXY",
      signatureType: 1,
      ownerSignerAddress: owner,
      orderSignerAddress: owner,
      orderMakerAddress: proxy,
      funderAddress: proxy
    });
  });

  it("maps POLY_1271 owner and contract roles", () => {
    const owner = "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344";
    const contract = "0x3333333333333333333333333333333333333333";
    expect(applyPoly1271Wallet(base, { owner, contract })).toEqual({
      walletMode: "POLY_1271",
      signatureType: 3,
      ownerSignerAddress: owner,
      orderSignerAddress: contract,
      orderMakerAddress: contract,
      funderAddress: contract
    });
  });
});
