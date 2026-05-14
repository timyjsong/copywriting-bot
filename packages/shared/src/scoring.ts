import type { RoastResultT } from "./schemas/index.js";

/**
 * Pure helpers around roast scoring. Kept separate from the agent so the UI
 * (and OG-image renderer) can format scores without pulling in Anthropic deps.
 */

export function scoreBand(score: number): "F" | "D" | "C" | "B" | "A" {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

export function scoreColor(score: number): string {
  if (score >= 85) return "#16a34a"; // green-600
  if (score >= 70) return "#65a30d"; // lime-600
  if (score >= 55) return "#ca8a04"; // yellow-600
  if (score >= 40) return "#ea580c"; // orange-600
  return "#dc2626"; // red-600
}

export function dimensionLabel(dim: string): string {
  return dim
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function summariseResult(result: RoastResultT): string {
  if (!result.is_real_cold_email) {
    return result.refusal_reason ?? "Not a cold-email sequence we can roast.";
  }
  const weakest = [...result.per_dimension].sort((a, b) => a.score - b.score)[0];
  if (!weakest) return `Score: ${result.overall_score}/100.`;
  return `Score: ${result.overall_score}/100 (${scoreBand(result.overall_score)}). Weakest: ${dimensionLabel(weakest.dimension)} (${weakest.score}/10).`;
}
