import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  captureServerEventMock,
  serviceClientMock,
  runRewriteAgentMock,
  runBrandVoiceAgentMock,
  getCampaignMetricsMock,
  computePerformanceMock,
} = vi.hoisted(() => ({
  captureServerEventMock: vi.fn(async () => undefined),
  serviceClientMock: vi.fn(),
  runRewriteAgentMock: vi.fn(),
  runBrandVoiceAgentMock: vi.fn(),
  getCampaignMetricsMock: vi.fn(),
  computePerformanceMock: vi.fn(),
}));

vi.mock("@copywriting-bot/shared/observability", () => ({
  captureServerEvent: captureServerEventMock,
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@copywriting-bot/db/client", () => ({
  serviceClient: serviceClientMock,
}));

vi.mock("@copywriting-bot/agents", () => ({
  rewrite: { runRewriteAgent: runRewriteAgentMock },
  brandVoice: { runBrandVoiceAgent: runBrandVoiceAgentMock },
  smartlead: { getCampaignMetrics: getCampaignMetricsMock },
  performance: { computePerformance: computePerformanceMock },
}));

import { runOnboardingPipeline } from "./onboarding.js";
import { runSendBatchGenerate } from "./sendBatch.js";
import { runPerformanceDailyPull } from "./performance.js";
import { makeStep, makeSupabaseFake, type TableConfig } from "./_test-fakes.js";

// ------------------------------------------------------------------- sendBatch

describe("sendBatchGenerate — error paths + edge cases", () => {
  const baseCampaign = {
    id: "camp-1",
    customer_id: "cust-1",
    sequence_id: "seq-1",
    daily_cap: 50,
    status: "sending",
    smartlead_campaign_id: "sl-1",
  };

  function wire(tables: Record<string, TableConfig>) {
    const fake = makeSupabaseFake(tables);
    serviceClientMock.mockReturnValue(fake.serviceClient());
    return fake;
  }

  beforeEach(() => {
    captureServerEventMock.mockClear();
    serviceClientMock.mockReset();
  });

  it("returns {status:'skipped'} when campaign.status is not warmup or sending", async () => {
    wire({
      campaigns: { select: { data: { ...baseCampaign, status: "paused" }, error: null } },
    });
    const { step, calls } = makeStep();

    const out = await runSendBatchGenerate({
      event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
      step: step as never,
    });

    expect(out).toEqual({ status: "skipped", reason: "campaign.status=paused" });
    // No batch creation step should have run
    expect(calls.find((c) => c.id === "create-batch")).toBeUndefined();
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });

  it("THROWS when load-campaign returns an error", async () => {
    wire({
      campaigns: { select: { data: null, error: new Error("conn refused") } },
    });
    const { step } = makeStep();

    await expect(
      runSendBatchGenerate({
        event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
        step: step as never,
      }),
    ).rejects.toThrow(/conn refused/);
  });

  it("THROWS 'Campaign not found' when load-campaign returns null data with no error", async () => {
    wire({
      campaigns: { select: { data: null, error: null } },
    });
    const { step } = makeStep();

    await expect(
      runSendBatchGenerate({
        event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
        step: step as never,
      }),
    ).rejects.toThrow(/Campaign not found/);
  });

  it("THROWS when create-batch insert errors", async () => {
    wire({
      campaigns: { select: { data: baseCampaign, error: null } },
      send_batches: { insert: { data: null, error: new Error("unique violation") } },
    });
    const { step } = makeStep();

    await expect(
      runSendBatchGenerate({
        event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
        step: step as never,
      }),
    ).rejects.toThrow(/unique violation/);
  });

  it("THROWS 'Could not create send_batch' when insert returns null data with no error", async () => {
    wire({
      campaigns: { select: { data: baseCampaign, error: null } },
      send_batches: { insert: { data: null, error: null } },
    });
    const { step } = makeStep();

    await expect(
      runSendBatchGenerate({
        event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
        step: step as never,
      }),
    ).rejects.toThrow(/Could not create send_batch/);
  });

  it("THROWS when create-approval insert errors", async () => {
    wire({
      campaigns: { select: { data: baseCampaign, error: null } },
      send_batches: { insert: { data: { id: "batch-1" }, error: null } },
      approvals_queue: { insert: { data: null, error: new Error("approvals down") } },
    });
    const { step } = makeStep();

    await expect(
      runSendBatchGenerate({
        event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
        step: step as never,
      }),
    ).rejects.toThrow(/approvals down/);
  });

  it("on timeout: marks send_batches row failed AND returns {status:'timeout',batchId}", async () => {
    const fake = wire({
      campaigns: { select: { data: baseCampaign, error: null } },
      send_batches: { insert: { data: { id: "batch-99" }, error: null } },
      approvals_queue: { insert: { data: { id: "approval-99" }, error: null } },
    });
    const { step } = makeStep(null); // null = waitForEvent timed out

    const out = await runSendBatchGenerate({
      event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
      step: step as never,
    });

    expect(out).toEqual({ status: "timeout", batchId: "batch-99" });
    // Persistence side-effect: send_batches.update({status:"failed"}).eq("id","batch-99")
    const writes = fake.recorded.update.send_batches;
    expect(writes).toHaveLength(1);
    expect(writes[0]!.values).toMatchObject({ status: "failed" });
    expect(writes[0]!.eqArgs).toEqual([["id", "batch-99"]]);
    // Funnel never fires on timeout
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });

  it("LOCKS contract: non-'reject' decisions (e.g. 'edit') fall into the approve branch", async () => {
    const fake = wire({
      campaigns: { select: { data: baseCampaign, error: null } },
      send_batches: {
        insert: { data: { id: "batch-1" }, error: null },
        count: { count: 0, error: null },
      },
      approvals_queue: { insert: { data: { id: "approval-1" }, error: null } },
    });
    const { step } = makeStep({ data: { decision: "edit", notes: "minor tweak" } });

    const out = await runSendBatchGenerate({
      event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
      step: step as never,
    });

    // Output reports the literal operator decision
    expect(out).toMatchObject({ status: "edit", batchId: "batch-1" });
    // send_batches row written as approved (current contract: !== "reject")
    expect(fake.recorded.update.send_batches[0]!.values).toMatchObject({ status: "approved" });
    // Funnel still fires (locks current behavior)
    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a funnel-emit failure so Inngest retries the step", async () => {
    wire({
      campaigns: { select: { data: baseCampaign, error: null } },
      send_batches: {
        insert: { data: { id: "batch-1" }, error: null },
        count: { count: 0, error: null },
      },
      approvals_queue: { insert: { data: { id: "approval-1" }, error: null } },
    });
    captureServerEventMock.mockRejectedValueOnce(new Error("posthog down"));
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runSendBatchGenerate({
        event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
        step: step as never,
      }),
    ).rejects.toThrow(/posthog down/);
  });
});

// ------------------------------------------------------------------ onboarding

describe("onboardingPipeline — error paths + intermediate writes", () => {
  const baseSequence = {
    id: "seq-1",
    original_text: "old copy",
    voice_profile_json: { url: "https://acme.example", content: "About us..." },
    icp_json: {
      industry: "B2B SaaS",
      company_stage: "Series A-B",
      size_range: "20-200",
      buyer_titles: ["Founder"],
      pain_signals: ["low reply rate"],
      geo: ["US"],
    },
  };

  const rewriteResult = {
    emails: [
      {
        step: 1,
        purpose: "open",
        send_delay_days: 0,
        subject: "s",
        body: "b",
        personalisation_tokens: [],
        diff_summary: "d",
        new_claims: [],
      },
    ],
    playbook_used: "p",
    expected_reply_rate_band: "4-7%",
    guardrail_flags: [],
    rationale: "r",
  };

  function wire(tables: Record<string, TableConfig>) {
    const fake = makeSupabaseFake(tables);
    serviceClientMock.mockReturnValue(fake.serviceClient());
    return fake;
  }

  beforeEach(() => {
    captureServerEventMock.mockClear();
    runRewriteAgentMock.mockReset();
    runBrandVoiceAgentMock.mockReset();
    serviceClientMock.mockReset();
    runBrandVoiceAgentMock.mockResolvedValue({
      ok: true,
      result: {
        tone: ["plain"],
        positioning: "p",
        key_phrases: [],
        avoid_phrases: [],
        reading_level: "professional",
        source_urls: ["https://acme.example"],
      },
    });
    runRewriteAgentMock.mockResolvedValue({ ok: true, result: rewriteResult });
  });

  it("THROWS when load-sequence returns an error", async () => {
    wire({ sequences: { select: { data: null, error: new Error("rls denied") } } });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
      }),
    ).rejects.toThrow(/rls denied/);
  });

  it("THROWS 'Brand voice profile required' when sequence is missing voice_profile_json url/content", async () => {
    wire({
      sequences: {
        select: {
          data: { ...baseSequence, voice_profile_json: { url: "", content: "" } },
          error: null,
        },
      },
    });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
      }),
    ).rejects.toThrow(/Brand voice profile required/);
    expect(runBrandVoiceAgentMock).not.toHaveBeenCalled();
  });

  it("THROWS 'Brand voice profile required' when runBrandVoiceAgent returns {ok:false}", async () => {
    wire({ sequences: { select: { data: baseSequence, error: null } } });
    runBrandVoiceAgentMock.mockResolvedValue({ ok: false, error: "scrape failed" });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
      }),
    ).rejects.toThrow(/Brand voice profile required/);
  });

  it("THROWS 'ICP definition missing' when icp_json is null", async () => {
    wire({
      sequences: { select: { data: { ...baseSequence, icp_json: null }, error: null } },
    });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
      }),
    ).rejects.toThrow(/ICP definition missing/);
    expect(runRewriteAgentMock).not.toHaveBeenCalled();
  });

  it("THROWS 'Rewrite Agent failed' when runRewriteAgent returns {ok:false}", async () => {
    wire({ sequences: { select: { data: baseSequence, error: null } } });
    runRewriteAgentMock.mockResolvedValue({ ok: false, error: "anthropic 429" });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
      }),
    ).rejects.toThrow(/Rewrite Agent failed: anthropic 429/);
  });

  it("writes the rewritten_text + status='pending_approval' intermediate before approval", async () => {
    const fake = wire({
      sequences: { select: { data: baseSequence, error: null } },
      approvals_queue: { insert: { data: { id: "approval-1" }, error: null } },
    });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await runOnboardingPipeline({
      event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
      step: step as never,
    });

    // Two sequence writes: (1) pending_approval w/ rewritten_text (2) final approved
    const writes = fake.recorded.update.sequences;
    expect(writes).toHaveLength(2);
    const intermediate = writes[0]!;
    expect(intermediate.values).toMatchObject({ status: "pending_approval" });
    expect(intermediate.values.rewritten_text).toEqual(expect.stringContaining("Step 1"));
    expect(intermediate.values.rewritten_text).toEqual(expect.stringContaining("Subject: s"));
    expect(intermediate.eqArgs).toEqual([["id", "seq-1"]]);
  });

  it("THROWS when sequences update during create-approval errors", async () => {
    wire({
      sequences: {
        select: { data: baseSequence, error: null },
        update: { data: null, error: new Error("sequences locked") },
      },
    });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
      }),
    ).rejects.toThrow(/sequences locked/);
  });

  it("THROWS when approvals_queue insert errors", async () => {
    wire({
      sequences: { select: { data: baseSequence, error: null } },
      approvals_queue: { insert: { data: null, error: new Error("approvals down") } },
    });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
      }),
    ).rejects.toThrow(/approvals down/);
  });

  it("LOCKS contract: non-'reject' decision (e.g. 'edit') triggers funnel + status=approved", async () => {
    const fake = wire({
      sequences: { select: { data: baseSequence, error: null } },
      approvals_queue: { insert: { data: { id: "approval-1" }, error: null } },
    });
    const { step } = makeStep({ data: { decision: "edit", notes: "tweak subject" } });

    const out = await runOnboardingPipeline({
      event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
      step: step as never,
    });

    expect(out.status).toBe("edit");
    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
    // approvals_queue written with status="approved" (current contract for non-"reject")
    expect(fake.recorded.update.approvals_queue[0]!.values).toMatchObject({ status: "approved" });
  });

  it("propagates a funnel-emit failure so Inngest retries the step", async () => {
    wire({
      sequences: { select: { data: baseSequence, error: null } },
      approvals_queue: { insert: { data: { id: "approval-1" }, error: null } },
    });
    captureServerEventMock.mockRejectedValueOnce(new Error("posthog down"));
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
      }),
    ).rejects.toThrow(/posthog down/);
  });
});

// ----------------------------------------------------------------- performance

describe("performanceDailyPull — error paths + edge cases", () => {
  function wire(tables: Record<string, TableConfig>) {
    const fake = makeSupabaseFake(tables);
    serviceClientMock.mockReturnValue(fake.serviceClient());
    return fake;
  }

  beforeEach(() => {
    captureServerEventMock.mockClear();
    getCampaignMetricsMock.mockReset();
    computePerformanceMock.mockReset();
    serviceClientMock.mockReset();
    getCampaignMetricsMock.mockResolvedValue({ sent: 100, unique_opens: 50, replies: 5 });
    computePerformanceMock.mockImplementation(({ campaign_id, customer_id }) => ({
      campaign_id,
      customer_id,
      current_reply_rate: 0.05,
      uplift_pct: 12,
      trigger_free_rewrite: false,
    }));
  });

  it("returns {processed:0, results:[]} when no active campaigns exist", async () => {
    wire({ campaigns: { pages: { pageSize: 200, pages: [[]] } } });
    const { step } = makeStep();

    const out = await runPerformanceDailyPull({ step: step as never });

    expect(out).toEqual({ processed: 0, results: [] });
    expect(getCampaignMetricsMock).not.toHaveBeenCalled();
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });

  it("skips a campaign whose smartlead_campaign_id is non-numeric (e.g. 'abc')", async () => {
    wire({
      campaigns: {
        pages: {
          pageSize: 200,
          pages: [
            [
              {
                id: "camp-bad",
                customer_id: "cust-bad",
                smartlead_campaign_id: "abc",
                started_at: "2026-04-01T00:00:00Z",
              },
              {
                id: "camp-good",
                customer_id: "cust-good",
                smartlead_campaign_id: "200",
                started_at: "2026-04-01T00:00:00Z",
              },
            ],
          ],
        },
      },
    });
    const { step } = makeStep();

    const out = await runPerformanceDailyPull({ step: step as never });

    expect(out.processed).toBe(1);
    expect(getCampaignMetricsMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "cust-good",
      "performance_report_sent",
      expect.objectContaining({ campaign_id: "camp-good" }),
    );
  });

  it("handles exact-pageSize boundary (200 rows then 0 rows) without an off-by-one re-read", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      id: `camp-${i}`,
      customer_id: `cust-${i}`,
      smartlead_campaign_id: null,
      started_at: "2026-04-01T00:00:00Z",
    }));
    const fake = wire({
      campaigns: { pages: { pageSize: 200, pages: [page1, []] } },
    });
    const { step } = makeStep();

    const out = await runPerformanceDailyPull({ step: step as never });

    expect(out.processed).toBe(0);
    // Must have made exactly two range calls: [0,199] then [200,399]; the
    // empty second page must terminate the loop (no third call).
    expect(fake.recorded.rangeCalls.campaigns).toEqual([
      [0, 199],
      [200, 399],
    ]);
  });

  it("uses days=0 when started_at is null (no past date math)", async () => {
    wire({
      campaigns: {
        pages: {
          pageSize: 200,
          pages: [
            [
              {
                id: "camp-X",
                customer_id: "cust-X",
                smartlead_campaign_id: "10",
                started_at: null,
              },
            ],
          ],
        },
      },
    });
    const { step } = makeStep();

    await runPerformanceDailyPull({ step: step as never });

    expect(computePerformanceMock).toHaveBeenCalledTimes(1);
    expect(computePerformanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ days_since_start: 0 }),
    );
  });

  it("THROWS when performance_snapshots upsert returns an error (so Inngest retries)", async () => {
    wire({
      campaigns: {
        pages: {
          pageSize: 200,
          pages: [
            [
              {
                id: "camp-A",
                customer_id: "cust-A",
                smartlead_campaign_id: "100",
                started_at: "2026-04-01T00:00:00Z",
              },
            ],
          ],
        },
      },
      performance_snapshots: { upsert: { error: new Error("snapshot write failed") } },
    });
    const { step } = makeStep();

    await expect(runPerformanceDailyPull({ step: step as never })).rejects.toThrow(
      /snapshot write failed/,
    );
    // Funnel should not have been emitted (upsert step throws before emit step)
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });

  it("propagates a funnel-emit failure so Inngest retries the step", async () => {
    wire({
      campaigns: {
        pages: {
          pageSize: 200,
          pages: [
            [
              {
                id: "camp-A",
                customer_id: "cust-A",
                smartlead_campaign_id: "100",
                started_at: "2026-04-01T00:00:00Z",
              },
            ],
          ],
        },
      },
    });
    captureServerEventMock.mockRejectedValueOnce(new Error("posthog down"));
    const { step } = makeStep();

    await expect(runPerformanceDailyPull({ step: step as never })).rejects.toThrow(/posthog down/);
  });
});
