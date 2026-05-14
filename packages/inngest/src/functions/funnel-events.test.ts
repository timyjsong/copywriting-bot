import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function read(file: string): string {
  return readFileSync(join(here, file), "utf8");
}

describe("inngest funnel event wiring", () => {
  it("onboardingPipeline emits rewrite_approved on approve", () => {
    const src = read("onboarding.ts");
    expect(src).toContain('captureServerEvent');
    expect(src).toContain('"rewrite_approved"');
    expect(src).toMatch(/decision\.data\.decision\s*!==\s*"reject"/);
  });

  it("sendBatchGenerate emits sequence_activated only on first approved batch", () => {
    const src = read("sendBatch.ts");
    expect(src).toContain('captureServerEvent');
    expect(src).toContain('"sequence_activated"');
    expect(src).toContain("count-prior-approved-batches");
    expect(src).toMatch(/\.neq\(\s*"id",\s*batchId\s*\)/);
  });

  it("performanceDailyPull emits performance_report_sent per snapshot", () => {
    const src = read("performance.ts");
    expect(src).toContain('captureServerEvent');
    expect(src).toContain('"performance_report_sent"');
    expect(src).toContain("snap.customer_id");
    expect(src).toContain("snap.campaign_id");
  });

  it("funnel emission steps run via step.run for durability", () => {
    expect(read("onboarding.ts")).toMatch(/step\.run\(\s*"emit-rewrite-approved-funnel"/);
    expect(read("sendBatch.ts")).toMatch(/step\.run\(\s*"emit-sequence-activated-funnel"/);
    expect(read("performance.ts")).toMatch(/step\.run\(\s*`emit-perf-report-funnel-\$\{camp\.id\}`/);
  });
});
