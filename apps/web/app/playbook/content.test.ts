import { describe, expect, it } from "vitest";
import { PLAYBOOK, getEntry } from "./content";

describe("playbook content", () => {
  it("ships at least the Phase 5 seed (>=10 entries)", () => {
    expect(PLAYBOOK.length).toBeGreaterThanOrEqual(10);
  });

  it("has unique kebab-case slugs", () => {
    const slugs = new Set<string>();
    for (const entry of PLAYBOOK) {
      expect(entry.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(slugs.has(entry.slug)).toBe(false);
      slugs.add(entry.slug);
    }
  });

  it("has all required fields populated and trimmed", () => {
    for (const entry of PLAYBOOK) {
      expect(entry.title.length).toBeGreaterThan(10);
      expect(entry.intent.length).toBeGreaterThan(20);
      expect(entry.painPoint.length).toBeGreaterThan(20);
      expect(entry.principle.length).toBeGreaterThan(20);
      expect(entry.counterExample.length).toBeGreaterThan(20);
      expect(entry.cta.length).toBeGreaterThan(10);
    }
  });

  it("returns null for unknown slugs", () => {
    expect(getEntry("does-not-exist")).toBeNull();
  });

  it("returns the entry for a known slug", () => {
    const known = PLAYBOOK[0]!.slug;
    const entry = getEntry(known);
    expect(entry).not.toBeNull();
    expect(entry?.slug).toBe(known);
  });
});
