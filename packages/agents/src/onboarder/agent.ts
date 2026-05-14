import { z } from "zod";
import { OnboardingPayload, type OnboardingPayloadT } from "@copywriting-bot/shared/schemas";

/**
 * Onboarder Agent — validates inputs and surfaces fixable issues to the user.
 *
 * Today this is a deterministic validator; in Phase 2 we'll layer an LLM pass
 * that critiques the ICP paragraph and suggests improvements before save.
 */

export const OnboardingReview = z.object({
  ok: z.boolean(),
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
});
export type OnboardingReviewT = z.infer<typeof OnboardingReview>;

export function reviewOnboardingPayload(input: unknown): OnboardingReviewT {
  const parsed = OnboardingPayload.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      suggestions: [],
    };
  }
  return runDeterministicChecks(parsed.data);
}

function runDeterministicChecks(p: OnboardingPayloadT): OnboardingReviewT {
  const issues: string[] = [];
  const suggestions: string[] = [];

  // Domain
  if (p.sending_domain.includes("gmail.com") || p.sending_domain.includes("outlook.com")) {
    issues.push(
      "Sending domain looks like a personal mailbox (gmail/outlook). You must own a dedicated cold-email domain.",
    );
  }

  // ICP paragraph quality
  const words = p.icp_paragraph.trim().split(/\s+/);
  if (words.length < 25) {
    issues.push("ICP paragraph is too short — under 25 words. Add the industry, stage, size, and pain trigger.");
  }
  if (words.length > 200) {
    suggestions.push("ICP paragraph is unusually long — try tightening to <120 words; the bot uses it as a system prompt input.");
  }

  // Sample target companies — must be domain-y
  const looksLikeDomain = (s: string) => /[a-z0-9-]+\.[a-z]{2,}/i.test(s);
  const malformed = p.sample_target_companies.filter((c) => !looksLikeDomain(c));
  if (malformed.length > 0) {
    suggestions.push(
      `These sample companies don't look like domains: ${malformed.join(", ")}. Use full domains (e.g. acme.com) so the bot can enrich them.`,
    );
  }

  // Calendar
  const calendarHost = safeHost(p.calendar_url);
  if (calendarHost && !["calendly.com", "cal.com", "savvycal.com", "hubspot.com"].some((h) => calendarHost.endsWith(h))) {
    suggestions.push(
      `Calendar URL is on '${calendarHost}'. We've only tested Calendly / cal.com / SavvyCal / HubSpot in MVP — other tools may render badly in cold emails.`,
    );
  }

  return { ok: issues.length === 0, issues, suggestions };
}

function safeHost(u: string): string | null {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}
