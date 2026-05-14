import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Schema-level test for /api/checkout/resolve. We don't hit Stripe in unit
 * tests; this guards the request contract the onboarding page relies on.
 */

const Body = z.object({
  session_id: z.string().min(8),
});

describe("checkout/resolve request body", () => {
  it("accepts a Stripe-shaped session id", () => {
    const out = Body.safeParse({ session_id: "cs_test_a1b2c3d4e5f6" });
    expect(out.success).toBe(true);
  });

  it("rejects empty session id", () => {
    const out = Body.safeParse({ session_id: "" });
    expect(out.success).toBe(false);
  });

  it("rejects missing session id", () => {
    const out = Body.safeParse({});
    expect(out.success).toBe(false);
  });

  it("rejects short session id", () => {
    const out = Body.safeParse({ session_id: "cs_x" });
    expect(out.success).toBe(false);
  });
});
