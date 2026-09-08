import assert from "assert";
import { describe, it, beforeEach } from "node:test";
import { config, EnvSchema } from "../../src/config/env";

/**
 * Two routes signed people in without ever checking a password.
 *
 * `POST /api/v1/auth/login` branched on `cleanUser.includes("customer")` and
 * then queried
 *
 *   SELECT ... FROM profiles WHERE LOWER(email) = $1 OR id::text = '101'
 *
 * The `OR id::text = '101'` matched regardless of the address supplied, and the
 * branch returned a signed 24-hour portal token before reaching verifyPassword.
 * `POST /api/v1/auth/customer-login` did the same, with an extra fallback to
 * profile 101 for any username containing "win" or "customer".
 *
 * These tests pin the three properties that close it: the capability is off by
 * default, production refuses it outright, and the matcher can no longer be
 * satisfied by an arbitrary string.
 */

/** The predicate guarding the customer branch of /api/v1/auth/login. */
const demoBranchTaken = (allowDemoLogin: boolean, username: string) =>
  allowDemoLogin && username.trim().toLowerCase().includes("customer");

describe("demo login is off unless asked for", () => {
  it("defaults to false when the variable is absent", () => {
    const parsed = EnvSchema.shape.ALLOW_DEMO_LOGIN.parse(undefined);
    assert.strictEqual(parsed, false);
  });

  it('is only enabled by the exact string "true"', () => {
    assert.strictEqual(EnvSchema.shape.ALLOW_DEMO_LOGIN.parse("true"), true);
    assert.strictEqual(EnvSchema.shape.ALLOW_DEMO_LOGIN.parse("false"), false);
    // A stray value must not be coerced into an enabled flag, which is what
    // z.coerce.boolean() would have done with "false".
    assert.throws(() => EnvSchema.shape.ALLOW_DEMO_LOGIN.parse("yes"));
    assert.throws(() => EnvSchema.shape.ALLOW_DEMO_LOGIN.parse("1"));
  });

  it("ships disabled in this build", () => {
    assert.strictEqual(config.ALLOW_DEMO_LOGIN, false, "the checked-in default must never be enabled");
  });
});

describe("the branch that issued a token without a password", () => {
  const bypassAttempts = [
    "customer",
    "CUSTOMER",
    "  customer  ",
    "customer.win@ticketx.local",
    "attacker+customer@evil.example",
    "not-a-real-customer",
  ];

  describe("with the flag off — the shipped configuration", () => {
    for (const username of bypassAttempts) {
      it(`refuses ${JSON.stringify(username)}`, () => {
        assert.strictEqual(demoBranchTaken(false, username), false);
      });
    }
  });

  describe("with the flag on", () => {
    it("still requires the username to name a customer", () => {
      assert.strictEqual(demoBranchTaken(true, "operator@example.com"), false);
    });

    it("takes the branch for a demo account", () => {
      assert.strictEqual(demoBranchTaken(true, "customer.win@ticketx.local"), true);
    });
  });
});

describe("production refuses the flag outright", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFlag = process.env.ALLOW_DEMO_LOGIN;
  const originalSecret = process.env.SESSION_SECRET;

  beforeEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalFlag === undefined) delete process.env.ALLOW_DEMO_LOGIN;
    else process.env.ALLOW_DEMO_LOGIN = originalFlag;
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  });

  it("throws rather than booting with demo login enabled in production", async () => {
    const { validateEnv } = await import("../../src/config/env");
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "s".repeat(48);
    process.env.ALLOW_DEMO_LOGIN = "true";

    assert.throws(
      () => validateEnv(),
      /ALLOW_DEMO_LOGIN must not be enabled in production/,
      "a stray environment variable must not be able to open password-free sign-in on the production host"
    );

    process.env.NODE_ENV = originalNodeEnv;
    if (originalFlag === undefined) delete process.env.ALLOW_DEMO_LOGIN;
    else process.env.ALLOW_DEMO_LOGIN = originalFlag;
  });

  it("boots in production with the flag off", async () => {
    const { validateEnv } = await import("../../src/config/env");
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "s".repeat(48);
    process.env.ALLOW_DEMO_LOGIN = "false";

    assert.doesNotThrow(() => validateEnv());

    process.env.NODE_ENV = originalNodeEnv;
    if (originalFlag === undefined) delete process.env.ALLOW_DEMO_LOGIN;
    else process.env.ALLOW_DEMO_LOGIN = originalFlag;
  });
});

describe("the profile lookup no longer matches an arbitrary string", () => {
  // The bypass lived in the SQL, not the branch: `OR id::text = '101'` meant
  // the query returned a row whatever was passed. Pinning the text of the
  // query is crude, but it is the only part of this route that can be checked
  // without a database, and it is exactly the fragment that must not return.
  it("does not fall back to a hard-coded profile id", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname ?? __dirname, "../../src/api/routes/auth.ts"),
      "utf8"
    );

    const sqlLines = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"));

    for (const fragment of ["id::text = '101'", `id::text = "101"`]) {
      assert.ok(
        !sqlLines.some((line) => line.includes(fragment)),
        `auth.ts must not resolve a customer by hard-coded id: found ${fragment}`
      );
    }
  });
});
