/**
 * Gate 2 smoke #9 — HMAC forgery rejection.
 * Also covers the happy path sign/verify round-trip and input shape validation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { signCallback, verifyCallback, generateNonce } from "../src/miracle/approval-card";

describe("HMAC callback (sign + verify)", () => {
  beforeEach(() => {
    process.env.MIRACLE_HMAC_SECRET = "test-secret-at-least-16-chars-long";
  });

  it("round-trips a legitimate Approve callback", () => {
    const aid = "aaaaaaaa0000000000000000";
    const nonce = "bbbbbbbb0000000000000000";
    const signed = signCallback(aid, nonce, "A");
    const verified = verifyCallback(signed.encoded);

    expect(verified).not.toBeNull();
    expect(verified?.aid8).toBe("aaaaaaaa");
    expect(verified?.nonce8).toBe("bbbbbbbb");
    expect(verified?.verdict).toBe("A");
  });

  it("produces callback_data within Telegram's 64-byte limit", () => {
    const signed = signCallback(generateNonce(), generateNonce(), "E");
    expect(signed.encoded.length).toBeLessThanOrEqual(64);
    // Actual fixed format is 32 bytes.
    expect(signed.encoded.length).toBe(32);
  });

  it("rejects a forged signature (Gate 2 smoke #9)", () => {
    const aid = "11111111-2222-3333-4444-555555555555";
    const nonce = generateNonce();
    const signed = signCallback(aid, nonce, "A");

    // Tamper with the last byte of the signature.
    const parts = signed.encoded.split(":");
    const lastByte = parts[4]!.slice(-1);
    const flipped = lastByte === "0" ? "1" : "0";
    const forged = parts.slice(0, -1).join(":") + ":" + parts[4]!.slice(0, -1) + flipped;

    expect(verifyCallback(forged)).toBeNull();
  });

  it("rejects a verdict swap without re-signing", () => {
    const signed = signCallback("abcdabcd12345678", "12341234567890ab", "A");
    // Substitute verdict but keep the original Approve signature.
    const parts = signed.encoded.split(":");
    parts[3] = "R";
    expect(verifyCallback(parts.join(":"))).toBeNull();
  });

  it("rejects malformed shapes without attempting HMAC verify", () => {
    expect(verifyCallback("mir:short")).toBeNull();
    expect(verifyCallback("notmir:aaaaaaaa:bbbbbbbb:A:ccccccc1")).toBeNull();
    expect(verifyCallback("mir:NOTHEX!!:bbbbbbbb:A:ccccccc1")).toBeNull();
    expect(verifyCallback("mir:aaaaaaaa:bbbbbbbb:Z:ccccccc1")).toBeNull();
  });

  it("throws loudly if MIRACLE_HMAC_SECRET is missing or too short", () => {
    delete process.env.MIRACLE_HMAC_SECRET;
    expect(() => signCallback("aaaa", "bbbb", "A")).toThrow(/MIRACLE_HMAC_SECRET/);

    process.env.MIRACLE_HMAC_SECRET = "too-short";
    expect(() => signCallback("aaaa", "bbbb", "A")).toThrow(/MIRACLE_HMAC_SECRET/);
  });

  it("rotating the secret invalidates previously-signed callbacks", () => {
    const signed = signCallback("abcdef0123456789", "fedcba9876543210", "A");
    process.env.MIRACLE_HMAC_SECRET = "different-secret-at-least-16-chr";
    expect(verifyCallback(signed.encoded)).toBeNull();
  });
});
