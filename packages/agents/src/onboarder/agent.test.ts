import { describe, expect, it } from "vitest";
import { reviewOnboardingPayload } from "./agent.js";

const goodPayload = {
  customer_id: "00000000-0000-0000-0000-000000000001",
  sending_domain: "outbound.acme.com",
  original_sequence:
    "Subject: trying acme\nBody: hi {{first_name}}, saw you raised yesterday and shipped the new dashboard, thought we could help with outbound.\n\nSubject: bump\nBody: did this land?",
  icp_paragraph:
    "Series A and Series B B2B SaaS companies selling to other SaaS teams, twenty to two hundred employees, head of growth or founder buyer, currently using Lemlist or Apollo or Smartlead with reply rates under three percent and no SDR hired yet.",
  sample_target_companies: ["linear.app", "vercel.com", "supabase.com"],
  calendar_url: "https://calendly.com/tim/30min",
  brand_voice_url: "https://acme.com",
};

describe("reviewOnboardingPayload", () => {
  it("accepts a valid payload", () => {
    const out = reviewOnboardingPayload(goodPayload);
    expect(out.ok).toBe(true);
    expect(out.issues).toEqual([]);
  });

  it("flags gmail.com sending domain as issue", () => {
    const out = reviewOnboardingPayload({ ...goodPayload, sending_domain: "promo.gmail.com" });
    expect(out.ok).toBe(false);
    expect(out.issues.some((i) => i.includes("personal mailbox"))).toBe(true);
  });

  it("flags short ICP paragraphs (below the deterministic 25-word threshold)", () => {
    // 24 words — long enough to pass zod's >=20 char check, short enough to hit our heuristic.
    const shortIcp =
      "B2B SaaS founders selling to other SaaS companies who already tried cold outbound and got nothing back after months of effort lately.";
    const out = reviewOnboardingPayload({ ...goodPayload, icp_paragraph: shortIcp });
    expect(out.ok).toBe(false);
    expect(out.issues.some((i) => i.includes("too short"))).toBe(true);
  });

  it("suggests cleanup for non-domain target companies", () => {
    const out = reviewOnboardingPayload({
      ...goodPayload,
      sample_target_companies: ["Linear", "Vercel", "Supabase"],
    });
    expect(out.ok).toBe(true);
    expect(out.suggestions.some((s) => s.includes("don't look like domains"))).toBe(true);
  });

  it("returns zod errors for missing fields", () => {
    const out = reviewOnboardingPayload({ customer_id: "not-a-uuid" });
    expect(out.ok).toBe(false);
    expect(out.issues.length).toBeGreaterThan(0);
  });

  it("returns zod errors for invalid email-shaped sending domain", () => {
    const out = reviewOnboardingPayload({ ...goodPayload, sending_domain: "founder@gmail.com" });
    expect(out.ok).toBe(false);
  });
});
