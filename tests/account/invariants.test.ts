import { validateAccountConfig, assertLiveWalletModeSupported } from "../../src/account/invariants.js";

const eoa = "0x1111111111111111111111111111111111111111";
const proxy = "0x2222222222222222222222222222222222222222";
const contractWallet = "0x3333333333333333333333333333333333333333";

describe("wallet mode invariants", () => {
  it("accepts EOA only when all account addresses match signature type 0", () => {
    expect(
      validateAccountConfig({
        walletMode: "EOA",
        signatureType: 0,
        ownerSignerAddress: eoa,
        orderMakerAddress: eoa,
        orderSignerAddress: eoa,
        funderAddress: eoa
      })
    ).toEqual({ ok: true });
  });

  it("rejects mismatched EOA addresses", () => {
    expect(
      validateAccountConfig({
        walletMode: "EOA",
        signatureType: 0,
        ownerSignerAddress: eoa,
        orderMakerAddress: proxy,
        orderSignerAddress: eoa,
        funderAddress: eoa
      })
    ).toMatchObject({ ok: false });
  });

  it("refuses EOA for live order submission with deposit wallet guidance", () => {
    const account = {
      walletMode: "EOA" as const,
      signatureType: 0 as const,
      ownerSignerAddress: eoa,
      orderMakerAddress: eoa,
      orderSignerAddress: eoa,
      funderAddress: eoa
    };
    expect(() => assertLiveWalletModeSupported(account)).toThrow(/configure POLY_1271 or POLY_PROXY/);
  });

  it("accepts POLY_PROXY modeled addresses for live", () => {
    const account = {
      walletMode: "POLY_PROXY" as const,
      signatureType: 1 as const,
      ownerSignerAddress: eoa,
      orderMakerAddress: proxy,
      orderSignerAddress: eoa,
      funderAddress: proxy
    };
    expect(validateAccountConfig(account)).toEqual({ ok: true });
    expect(() => assertLiveWalletModeSupported(account)).not.toThrow();
  });

  it("accepts POLY_1271 modeled addresses for live", () => {
    const account = {
      walletMode: "POLY_1271" as const,
      signatureType: 3 as const,
      ownerSignerAddress: eoa,
      orderMakerAddress: contractWallet,
      orderSignerAddress: contractWallet,
      funderAddress: contractWallet
    };
    expect(validateAccountConfig(account)).toEqual({ ok: true });
    expect(() => assertLiveWalletModeSupported(account)).not.toThrow();
  });
});
