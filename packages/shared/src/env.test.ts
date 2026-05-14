import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetEnvForTests, serverEnv, publicEnv } from "./env.js";

/**
 * env.ts is the validation boundary that decides whether the process is
 * allowed to talk to external services. Tests defend:
 *  - required fields throw with a useful message listing the offending keys
 *  - optional fields stay undefined when not set
 *  - default values fill in (NODE_ENV, model IDs, SMARTLEAD_BASE_URL, etc)
 *  - memoization: second call returns the same object without re-parsing
 *  - trueish coercion ("1", "true", "TRUE" → true; anything else → false)
 *  - publicEnv only reads NEXT_PUBLIC_* keys (no server-side leakage)
 *  - __resetEnvForTests clears the cache so a new env can be parsed
 */

const ENV_KEYS_TO_CLEAR = [
  "NODE_ENV",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL_PLANNING",
  "ANTHROPIC_MODEL_DEVELOPMENT",
  "ANTHROPIC_MODEL_FAST",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_ID_FULL_REWRITE",
  "INNGEST_EVENT_KEY",
  "INNGEST_SIGNING_KEY",
  "INNGEST_DEV",
  "POSTMARK_SERVER_TOKEN",
  "POSTMARK_FROM_ADDRESS",
  "SMARTLEAD_API_KEY",
  "SMARTLEAD_BASE_URL",
  "APOLLO_API_KEY",
  "SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "POSTHOG_SERVER_KEY",
  "OPERATOR_EMAIL",
  "APPROVAL_GATES_DEFAULT_ON",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_OPS_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SENTRY_DSN",
  "NEXT_PUBLIC_POSTHOG_KEY",
  "NEXT_PUBLIC_POSTHOG_HOST",
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS_TO_CLEAR) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  __resetEnvForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS_TO_CLEAR) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __resetEnvForTests();
});

function setRequired(): void {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb-test";
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy";
}

describe("serverEnv()", () => {
  it("throws with all missing required keys listed when nothing is set", () => {
    expect(() => serverEnv()).toThrow(/Invalid server environment/);
    try {
      serverEnv();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("ANTHROPIC_API_KEY");
      expect(msg).toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(msg).toContain("STRIPE_SECRET_KEY");
      expect(msg).toContain("STRIPE_WEBHOOK_SECRET");
    }
  });

  it("returns parsed env on the happy path with model defaults", () => {
    setRequired();
    const env = serverEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.ANTHROPIC_MODEL_PLANNING).toBe("claude-opus-4-7");
    expect(env.ANTHROPIC_MODEL_DEVELOPMENT).toBe("claude-sonnet-4-6");
    expect(env.ANTHROPIC_MODEL_FAST).toBe("claude-haiku-4-5-20251001");
    expect(env.NODE_ENV).toBe("development");
    expect(env.SMARTLEAD_BASE_URL).toBe("https://server.smartlead.ai/api/v1");
  });

  it("respects explicit overrides over defaults", () => {
    setRequired();
    process.env.ANTHROPIC_MODEL_PLANNING = "claude-opus-5-0";
    (process.env as Record<string, string>).NODE_ENV = "production";
    const env = serverEnv();
    expect(env.ANTHROPIC_MODEL_PLANNING).toBe("claude-opus-5-0");
    expect(env.NODE_ENV).toBe("production");
  });

  it("rejects unknown NODE_ENV values", () => {
    setRequired();
    (process.env as Record<string, string>).NODE_ENV = "staging";
    expect(() => serverEnv()).toThrow(/NODE_ENV/);
  });

  it("treats truthy strings for INNGEST_DEV as true", () => {
    setRequired();
    process.env.INNGEST_DEV = "1";
    expect(serverEnv().INNGEST_DEV).toBe(true);
    __resetEnvForTests();
    process.env.INNGEST_DEV = "true";
    expect(serverEnv().INNGEST_DEV).toBe(true);
    __resetEnvForTests();
    process.env.INNGEST_DEV = "TRUE";
    expect(serverEnv().INNGEST_DEV).toBe(true);
  });

  it("treats anything else (or missing) for INNGEST_DEV as false", () => {
    setRequired();
    expect(serverEnv().INNGEST_DEV).toBe(false);
    __resetEnvForTests();
    process.env.INNGEST_DEV = "0";
    expect(serverEnv().INNGEST_DEV).toBe(false);
    __resetEnvForTests();
    process.env.INNGEST_DEV = "false";
    expect(serverEnv().INNGEST_DEV).toBe(false);
    __resetEnvForTests();
    process.env.INNGEST_DEV = "no";
    expect(serverEnv().INNGEST_DEV).toBe(false);
  });

  it("memoizes the parsed env (same reference on repeat calls)", () => {
    setRequired();
    const a = serverEnv();
    const b = serverEnv();
    expect(a).toBe(b);
  });

  it("__resetEnvForTests invalidates the cache so a new env is parsed", () => {
    setRequired();
    const a = serverEnv();
    __resetEnvForTests();
    process.env.ANTHROPIC_API_KEY = "sk-ant-rotated";
    const b = serverEnv();
    expect(a).not.toBe(b);
    expect(b.ANTHROPIC_API_KEY).toBe("sk-ant-rotated");
  });

  it("rejects malformed STRIPE_PRICE_ID_FULL_REWRITE (empty string)", () => {
    setRequired();
    process.env.STRIPE_PRICE_ID_FULL_REWRITE = "";
    expect(() => serverEnv()).toThrow();
  });

  it("rejects invalid POSTMARK_FROM_ADDRESS (not an email)", () => {
    setRequired();
    process.env.POSTMARK_FROM_ADDRESS = "not-an-email";
    expect(() => serverEnv()).toThrow(/POSTMARK_FROM_ADDRESS/);
  });

  it("rejects invalid SMARTLEAD_BASE_URL (not a URL)", () => {
    setRequired();
    process.env.SMARTLEAD_BASE_URL = "not a url";
    expect(() => serverEnv()).toThrow(/SMARTLEAD_BASE_URL/);
  });
});

describe("publicEnv()", () => {
  it("requires NEXT_PUBLIC_SUPABASE_URL and ANON_KEY", () => {
    expect(() => publicEnv()).toThrow(/Invalid public environment/);
    try {
      publicEnv();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("NEXT_PUBLIC_SUPABASE_URL");
      expect(msg).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    }
  });

  it("returns defaults for APP_URL / OPS_URL / POSTHOG_HOST when unset", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    const env = publicEnv();
    expect(env.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
    expect(env.NEXT_PUBLIC_OPS_URL).toBe("http://localhost:3001");
    expect(env.NEXT_PUBLIC_POSTHOG_HOST).toBe("https://us.i.posthog.com");
  });

  it("rejects non-URL NEXT_PUBLIC_APP_URL", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    process.env.NEXT_PUBLIC_APP_URL = "not a url";
    expect(() => publicEnv()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it("memoizes and reset works", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    const a = publicEnv();
    expect(publicEnv()).toBe(a);
    __resetEnvForTests();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://y.supabase.co";
    const b = publicEnv();
    expect(b).not.toBe(a);
    expect(b.NEXT_PUBLIC_SUPABASE_URL).toBe("https://y.supabase.co");
  });
});
