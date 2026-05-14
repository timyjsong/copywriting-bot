import { describe, expect, it } from "vitest";
import { dimensionLabel, scoreBand, scoreColor, summariseResult } from "./scoring.js";
import type { RoastResultT } from "./schemas/index.js";

describe("scoring helpers", () => {
  it("bands scores correctly at boundaries", () => {
    expect(scoreBand(0)).toBe("F");
    expect(scoreBand(39)).toBe("F");
    expect(scoreBand(40)).toBe("D");
    expect(scoreBand(54)).toBe("D");
    expect(scoreBand(55)).toBe("C");
    expect(scoreBand(69)).toBe("C");
    expect(scoreBand(70)).toBe("B");
    expect(scoreBand(84)).toBe("B");
    expect(scoreBand(85)).toBe("A");
    expect(scoreBand(100)).toBe("A");
  });

  it("returns a colour string for every score", () => {
    for (const s of [0, 40, 55, 70, 85, 100]) {
      expect(scoreColor(s)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("formats dimension labels in title case with spaces", () => {
    expect(dimensionLabel("subject_line")).toBe("Subject Line");
    expect(dimensionLabel("opener_personalization")).toBe("Opener Personalization");
  });

  it("summarises a refused result", () => {
    const refused: RoastResultT = {
      is_real_cold_email: false,
      refusal_reason: "This is a marketing newsletter, not a cold email.",
      overall_score: 0,
      per_dimension: [
        { dimension: "subject_line", score: 0, rationale: "n/a" },
        { dimension: "opener_personalization", score: 0, rationale: "n/a" },
        { dimension: "value_clarity", score: 0, rationale: "n/a" },
        { dimension: "social_proof", score: 0, rationale: "n/a" },
        { dimension: "cta_strength", score: 0, rationale: "n/a" },
        { dimension: "sequencing", score: 0, rationale: "n/a" },
      ],
      worst_email_index: null,
      rewrite_preview: null,
      share_caption: "n/a",
    };
    expect(summariseResult(refused)).toContain("newsletter");
  });

  it("summarises a normal result with weakest dimension callout", () => {
    const result: RoastResultT = {
      is_real_cold_email: true,
      refusal_reason: null,
      overall_score: 62,
      per_dimension: [
        { dimension: "subject_line", score: 7, rationale: "ok" },
        { dimension: "opener_personalization", score: 3, rationale: "weak" },
        { dimension: "value_clarity", score: 6, rationale: "ok" },
        { dimension: "social_proof", score: 6, rationale: "ok" },
        { dimension: "cta_strength", score: 6, rationale: "ok" },
        { dimension: "sequencing", score: 6, rationale: "ok" },
      ],
      worst_email_index: 1,
      rewrite_preview: null,
      share_caption: "C",
    };
    const summary = summariseResult(result);
    expect(summary).toContain("62/100");
    expect(summary).toContain("Opener Personalization");
  });
});
