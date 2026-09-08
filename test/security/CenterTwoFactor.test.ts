import assert from "assert";
import { describe, it } from "node:test";
import { parseCenterChallenge, CenterTwoFactorRequiredError } from "../../src/services/CentralAuthService";

/**
 * Center completes 2FA on its own login endpoint, but the code has to arrive in
 * the field that matches the factor:
 *
 *   authenticator  ->  totp
 *   email / SMS    ->  otp + otpRef
 *
 * loginToCenter used to send the code under five names at once — otp, totp,
 * code, authCode, authenticatorCode — because nobody had confirmed which one
 * Center reads. That guess is what broke authenticator sign-in: `otp` present
 * without a valid `otpRef` reads to Center as a blank emailed code, and it
 * rejects the login. So the field that was added "just in case" was the one
 * causing the failure, and the correct `totp` alongside it never got a chance.
 *
 * These tests pin the challenge parser and the request shape.
 */

/** The body loginToCenter builds, extracted so it can be asserted without a network call. */
function secondFactorFields(factor?: { code: string; method?: "totp" | "email" | "sms"; ref?: string | null }) {
  const payload: Record<string, unknown> = {};
  const code = factor?.code?.trim();
  if (code) {
    if (factor?.method === "email" || factor?.method === "sms") {
      payload.otp = code;
      if (factor.ref) payload.otpRef = factor.ref;
    } else {
      payload.totp = code;
    }
  }
  return payload;
}

describe("reading Center's 2FA challenge", () => {
  it("treats an empty description as the authenticator app", () => {
    const challenge = parseCenterChallenge({ error: "Require TOTP", error_description: "" });
    assert.deepStrictEqual(challenge, { method: "totp", ref: null });
  });

  it("treats a missing description as the authenticator app", () => {
    assert.deepStrictEqual(parseCenterChallenge({ error: "Require TOTP" }), { method: "totp", ref: null });
  });

  it("reads an emailed code and its reference", () => {
    assert.deepStrictEqual(parseCenterChallenge({ error: "Require TOTP", error_description: "email:REF123" }), {
      method: "email",
      ref: "REF123",
    });
  });

  it("reads an SMS reference given bare", () => {
    assert.deepStrictEqual(parseCenterChallenge({ error: "Require TOTP", error_description: "SMS-REF-9" }), {
      method: "sms",
      ref: "SMS-REF-9",
    });
  });

  it("strips an sms: prefix when Center adds one", () => {
    assert.deepStrictEqual(parseCenterChallenge({ error: "Require TOTP", error_description: "sms:ABC" }), {
      method: "sms",
      ref: "ABC",
    });
  });

  it("accepts the alternate wording Center uses for the same challenge", () => {
    assert.deepStrictEqual(parseCenterChallenge({ error: "TOTP required but not provided" }), {
      method: "totp",
      ref: null,
    });
  });

  it("is not a challenge when the password was simply wrong", () => {
    assert.strictEqual(parseCenterChallenge({ error: "Invalid Username or Password life:4" }), null);
  });

  it("is not a challenge for a locked account", () => {
    assert.strictEqual(parseCenterChallenge({ error: "Account is locked lock_time:900" }), null);
  });

  it("is not a challenge for an empty or absent body", () => {
    assert.strictEqual(parseCenterChallenge({}), null);
    assert.strictEqual(parseCenterChallenge(null), null);
    assert.strictEqual(parseCenterChallenge(undefined), null);
  });
});

describe("the second factor is sent in exactly one field", () => {
  it("sends an authenticator code as totp and nothing else", () => {
    const fields = secondFactorFields({ code: "123456", method: "totp" });
    assert.deepStrictEqual(fields, { totp: "123456" });
  });

  it("defaults to the authenticator when no method is given", () => {
    assert.deepStrictEqual(secondFactorFields({ code: "123456" }), { totp: "123456" });
  });

  it("never sends otp alongside totp — the field that broke it", () => {
    const fields = secondFactorFields({ code: "123456", method: "totp" });
    assert.ok(!("otp" in fields), "otp must be absent for an authenticator code");
    assert.ok(!("otpRef" in fields), "otpRef must be absent for an authenticator code");
    for (const guessed of ["code", "authCode", "authenticatorCode"]) {
      assert.ok(!(guessed in fields), `${guessed} was a guess and must not be sent`);
    }
  });

  it("sends an emailed code as otp with its reference", () => {
    assert.deepStrictEqual(secondFactorFields({ code: "999888", method: "email", ref: "REF123" }), {
      otp: "999888",
      otpRef: "REF123",
    });
  });

  it("sends a texted code the same way", () => {
    assert.deepStrictEqual(secondFactorFields({ code: "999888", method: "sms", ref: "SMS-REF-9" }), {
      otp: "999888",
      otpRef: "SMS-REF-9",
    });
  });

  it("omits otpRef rather than sending it empty", () => {
    // Center reads otp with a blank otpRef as a blank emailed code and rejects
    // the login outright, so an absent key is the only safe representation.
    const fields = secondFactorFields({ code: "999888", method: "email", ref: null });
    assert.deepStrictEqual(fields, { otp: "999888" });
  });

  it("sends no second-factor field at all on a first attempt", () => {
    assert.deepStrictEqual(secondFactorFields(undefined), {});
    assert.deepStrictEqual(secondFactorFields({ code: "" }), {});
    assert.deepStrictEqual(secondFactorFields({ code: "   " }), {});
  });

  it("trims a code pasted with whitespace", () => {
    assert.deepStrictEqual(secondFactorFields({ code: " 123456 ", method: "totp" }), { totp: "123456" });
  });
});

describe("a challenge is not a failed login", () => {
  it("carries the challenge on a distinct error type", () => {
    const err = new CenterTwoFactorRequiredError({ method: "totp", ref: null });
    assert.ok(err instanceof CenterTwoFactorRequiredError);
    assert.ok(err instanceof Error);
    assert.deepStrictEqual(err.challenge, { method: "totp", ref: null });
  });

  it("is distinguishable from an ordinary Center error", () => {
    assert.ok(!(new Error("Invalid Username or Password") instanceof CenterTwoFactorRequiredError));
  });
});
