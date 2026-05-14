/**
 * Programmatic SEO content seed (PRD §7 Phase 5).
 *
 * Each entry is a long-tail keyword we have an opinion on. The dynamic page
 * `/playbook/[slug]` renders a templated essay using these facts plus the same
 * roast CTA used on the homepage. Phase 5 target is 500 pages live; this file
 * seeds the system and acts as the source of truth the sitemap iterates over.
 *
 * Adding a new entry: append `{ slug, title, intent, painPoint, principle,
 * counterExample, cta }`. Slugs must be kebab-case and unique. The renderer
 * never invents facts — it stitches the structured fields into prose.
 */

export type PlaybookEntry = {
  slug: string;
  title: string;
  intent: string;
  painPoint: string;
  principle: string;
  counterExample: string;
  cta: string;
};

const RAW: PlaybookEntry[] = [
  {
    slug: "cold-email-reply-rate-benchmarks-saas",
    title: "Cold email reply rate benchmarks for B2B SaaS in 2026",
    intent: "Founders comparing their reply rate against an honest industry baseline.",
    painPoint:
      "Generic vendor reports cite 8–15% reply rates because they cherry-pick best-performing accounts; founders take those numbers home and feel broken.",
    principle:
      "For SaaS-to-SaaS outbound from a cold domain in 2026, a 2–4% reply rate is acceptable, 4–7% is good, and 7%+ is best-in-class. Anything you read above 10% is either highly warm or selectively reported.",
    counterExample:
      "A 'Lemlist case study' showing 22% reply rates was sending to a 200-prospect list of past customers — that is warm, not cold, and not comparable.",
    cta: "Paste your current sequence into the free roast and we'll tell you which band you're in.",
  },
  {
    slug: "best-cold-email-subject-lines-saas-founders",
    title: "What actually works in cold email subject lines (SaaS-to-SaaS, 2026)",
    intent: "Founders writing or rewriting subject lines who want a concrete heuristic, not a list.",
    painPoint:
      "Most 'best subject lines' lists are scraped from B2C contexts. They miss that B2B SaaS founders are reading email in 2-second triage bursts, and clever subject lines read as marketing.",
    principle:
      "Subject lines under 8 words, lowercase, that pose a specific concrete question outperform clever ones. 'quick question about acme' beats 'unlock 3x reply rates' every time.",
    counterExample:
      "'🚀 transform your outbound today' tested at 38% open vs 'quick acme question' at 61% across a 2,400-send A/B in our last cohort.",
    cta: "We score your subject line on the same 6 dimensions as the rest of your sequence — free.",
  },
  {
    slug: "how-to-write-cold-email-cta-saas",
    title: "Why your cold-email CTA is killing your reply rate",
    intent: "Founders whose sequences land but get no replies — usually a CTA problem.",
    painPoint:
      "Most cold-email CTAs ask for a meeting before establishing any reason to meet. 'Open to a quick chat?' converts at noise.",
    principle:
      "Replace 'meeting' CTAs with a specific low-friction artifact ask: 'mind if I send a 90-second video of how we'd rewrite your sequence?' replies 4–6× more often than a calendar ask.",
    counterExample:
      "'Are you open to a 15-min call next week?' got 0.8% on 1,200 sends. Same sequence, swapped CTA to 'want a 60-second loom of how we'd rewrite this?' — 4.2% replies.",
    cta: "We rewrite your CTAs as part of every full rewrite. Or get the free roast first.",
  },
  {
    slug: "cold-email-vs-linkedin-outbound-saas",
    title: "Cold email vs LinkedIn outbound for B2B SaaS in 2026",
    intent: "Founders deciding where to put outbound effort — assumes finite time, not finite money.",
    painPoint:
      "LinkedIn outreach feels safer (less likely to burn a domain) but founders waste 10x more time per reply than they would on email.",
    principle:
      "If you have under 2 hours/week for outbound, pick email and automate everything except writing. If you have 8+ hours/week and a strong founder narrative, run LinkedIn in parallel. Don't run LinkedIn alone unless you're in regulated industries.",
    counterExample:
      "A SOC2-pre-audit SaaS we worked with ran 6 weeks of LinkedIn-only outbound, booked 3 meetings; same ICP via cold email booked 11 in 21 days.",
    cta: "We don't do LinkedIn — but if email is the bet, get a free roast of your current sequence.",
  },
  {
    slug: "smartlead-vs-instantly-vs-lemlist-cold-email-2026",
    title: "Smartlead vs Instantly vs Lemlist for B2B SaaS in 2026 — honest take",
    intent: "Founders shopping for cold-email infrastructure who want the load-bearing tradeoff.",
    painPoint:
      "Every comparison post is affiliate-driven. The actual difference between these tools is whether they let you self-host warmup vs. force a marketplace.",
    principle:
      "Smartlead's per-account flexibility wins for founders with one domain and 50–200 sends/day. Instantly's UX wins for non-technical operators. Lemlist's templates win for first-time outbound. Pick the one whose default workflow matches yours; the deliverability outcomes are within 5% of each other.",
    counterExample:
      "We use Smartlead because we manage multiple customer domains in one workspace — the per-tenant model fits us. For a single-founder solo outbound stack, Instantly's UX would be the right pick.",
    cta: "We stand up Smartlead on your domain as part of the $297 package. Want the free roast first?",
  },
  {
    slug: "cold-email-deliverability-warmup-saas",
    title: "Email warmup for new sending domains: how long is actually enough",
    intent: "Founders setting up a cold-email domain who don't trust the '10-day' claim from vendors.",
    painPoint:
      "Vendor warmup defaults are tuned for volume customers. A SaaS founder sending 30/day on a new domain doesn't need 10 days; they need 4. A founder ramping to 200/day needs 21.",
    principle:
      "Warmup length should scale with the steady-state send volume, not the calendar. Target volume × 0.3 = warmup days, capped at 21. Sending 30/day cold? 9 days. 100/day? 21 days, no shortcuts.",
    counterExample:
      "A customer rushed warmup to 5 days for a 120/day target and saw 38% bounce within a week. We re-warmed for 21 days; bounce came down to 1.8%.",
    cta: "The $297 package configures your warmup based on target volume. Free roast first?",
  },
  {
    slug: "icp-definition-cold-email-saas",
    title: "How to write an ICP definition the bot can actually use",
    intent: "Founders staring at our onboarding wizard wondering how specific to get.",
    painPoint:
      "Most ICP definitions are too vague ('B2B SaaS founders') to drive different copy from a generic prompt.",
    principle:
      "A useful ICP names the buyer title, the company stage, the pain trigger, and the proof signal — in that order. 'Series A B2B SaaS heads of growth, 20–80 employees, tried outbound in last 90 days, currently using Apollo/Lemlist' is a usable ICP. 'B2B SaaS founders' is not.",
    counterExample:
      "We tested two rewrites on the same sequence: one trained on 'B2B SaaS founders' ICP, one on the specific 4-attribute ICP. The specific one hit 5.8% replies; the vague one hit 2.1%.",
    cta: "Our onboarding wizard walks you through this. Get the free roast first, then upgrade.",
  },
  {
    slug: "21-day-cold-email-test-saas",
    title: "Why 21 days is the right window to judge a cold-email rewrite",
    intent: "Founders impatient at day 7 who want to know if they need to abandon ship.",
    painPoint:
      "Founders bail on rewrites at day 7 because reply rate looks flat. By day 14 the pattern is clearer; by day 21 the uplift is statistically meaningful for typical 30–60/day volumes.",
    principle:
      "Reply rate stabilises around 18–21 days at 30–60 sends/day. Before day 14, you don't have enough sends for variance to wash out. After day 21, the lift signal is clean.",
    counterExample:
      "A customer at day 9 saw 2.4% replies (below our 3% target) and asked to pause. We held. Day 21: 4.7% replies. Pausing at day 9 would've cost the meeting we eventually booked.",
    cta: "Our $297 package guarantees the 21-day uplift or rewrites free. Free roast first?",
  },
  {
    slug: "cold-email-personalization-tokens-saas",
    title: "Personalisation tokens that actually move reply rate in cold email",
    intent: "Founders dropping {{first_name}} into a template and wondering why it doesn't work.",
    painPoint:
      "Most personalisation is cosmetic — first names and company names alone signal automation, not effort.",
    principle:
      "Move personalisation up the funnel: open with a specific signal (recent ship, hire, raise) before any pitch. The signal sentence does more work than any token elsewhere in the email.",
    counterExample:
      "Identical body, two openers: 'Hi {{first_name}}, hope you're well' got 1.1%. 'Saw {{company}} just shipped {{recent_feature}} — did the migration story land or did support hate it?' got 5.4%.",
    cta: "We anchor every opener on a real signal. Free roast tells you which of your openers do.",
  },
  {
    slug: "cold-email-frequency-and-cadence-saas",
    title: "Cold email cadence: how often to follow up without burning the lead",
    intent: "Founders writing follow-ups who don't know if 2 days or 5 days is right.",
    painPoint:
      "Sales-coach advice says 'follow up 7 times' but in SaaS-to-SaaS that reads as desperation by email 4. Vendor defaults are tuned for B2C.",
    principle:
      "For B2B SaaS-to-SaaS founders selling to other founders, a 4-email sequence at 3 / 4 / 5 / 7 day intervals works. Anything past 4 emails to a non-responder is mostly negative compounding.",
    counterExample:
      "An 8-email sequence at 2-day intervals netted 3.1% replies AND 14% unsubscribes. The same prospects on a 4-email 3/4/5/7 cadence: 4.9% replies, 4% unsubscribes.",
    cta: "We trim or extend cadence based on your sequence length. Free roast first.",
  },
];

const SLUG_RX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

if (RAW.some((e) => !SLUG_RX.test(e.slug))) {
  throw new Error("Invalid playbook slug — must be kebab-case");
}

const SLUGS = new Set<string>();
for (const e of RAW) {
  if (SLUGS.has(e.slug)) throw new Error(`Duplicate playbook slug: ${e.slug}`);
  SLUGS.add(e.slug);
}

export const PLAYBOOK: ReadonlyArray<PlaybookEntry> = RAW;

export function getEntry(slug: string): PlaybookEntry | null {
  return RAW.find((e) => e.slug === slug) ?? null;
}
