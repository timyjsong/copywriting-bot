import { describe, expect, it } from "vitest";
import { RoastRequest } from "@copywriting-bot/shared/schemas";

/**
 * The route depends on Anthropic + Supabase, so we don't exercise it end-to-end
 * in unit tests. Instead we verify the request schema covers the cases the UI
 * can produce — this is the contract that keeps the form and the handler in
 * lock-step.
 */

describe("RoastRequest validation", () => {
  it("accepts a typical paste", () => {
    const out = RoastRequest.safeParse({
      email: "user@example.com",
      sequence: "Subject: hi\n\nHey {{first_name}}, saw you launched X. Could we trade notes? — Alex",
      source: "web",
    });
    expect(out.success).toBe(true);
  });

  it("rejects too-short sequences", () => {
    const out = RoastRequest.safeParse({ email: "user@example.com", sequence: "too short" });
    expect(out.success).toBe(false);
  });

  it("rejects invalid emails", () => {
    const out = RoastRequest.safeParse({
      email: "not-an-email",
      sequence: "Subject: hi\n\nHey there, this is at least forty characters long for the validator.",
    });
    expect(out.success).toBe(false);
  });

  it("rejects pastes over 20k characters", () => {
    const out = RoastRequest.safeParse({
      email: "user@example.com",
      sequence: "x".repeat(20_001),
    });
    expect(out.success).toBe(false);
  });
});
