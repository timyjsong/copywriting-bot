import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  captureServerEventMock,
  runRewriteAgentMock,
  runBrandVoiceAgentMock,
  getCampaignMetricsMock,
  computePerformanceMock,
} = vi.hoisted(() => ({
  captureServerEventMock: vi.fn(async () => undefined),
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

vi.mock("@copywriting-bot/agents", () => ({
  rewrite: { runRewriteAgent: runRewriteAgentMock },
  brandVoice: { runBrandVoiceAgent: runBrandVoiceAgentMock },
  smartlead: { getCampaignMetrics: getCampaignMetricsMock },
  performance: { computePerformance: computePerformanceMock },
}));

// NOTE: no `vi.mock("@copywriting-bot/db/client")` — the pipeline functions
// take `db` via their ctx so tests inject the fake directly. This is the
// DI seam from iter 10 that closes the "pure functions still call
// serviceClient() internally" finding.

import { runOnboardingPipeline } from "./onboarding.js";
import { runSendBatchGenerate } from "./sendBatch.js";
import { runPerformanceDailyPull, parseSmartleadCampaignId } from "./performance.js";
import {
  assertUniqueStepIds,
  makeStep,
  makeSupabaseFake,
  type TableConfig,
} from "../test-utils/supabase-fake.js";

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
    return makeSupabaseFake(tables);
  }

  beforeEach(() => {
    // mockReset (not mockClear) so an unconsumed mockRejectedValueOnce from a
    // failing test cannot leak into the next test's queue; reapply the default
    // resolved-undefined impl after the reset.
    captureServerEventMock.mockReset();
    captureServerEventMock.mockImplementation(async () => undefined);
  });

  it("returns {status:'skipped'} when campaign.status is not warmup or sending", async () => {
    const fake = wire({
      campaigns: { select: { data: { ...baseCampaign, status: "paused" }, error: null } },
    });
    const { step, calls } = makeStep();

    const out = await runSendBatchGenerate({
      event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
      step: step as never,
      db: fake.db,
    });

    expect(out).toEqual({ status: "skipped", reason: "campaign.status=paused" });
    expect(calls.find((c) => c.id === "create-batch")).toBeUndefined();
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });

  it("THROWS when load-campaign returns an error", async () => {
    const fake = wire({
      campaigns: { select: { data: null, error: new Error("conn refused") } },
    });
    const { step } = makeStep();

    await expect(
      runSendBatchGenerate({
        event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
        step: step as never,
        db: fake.db,
      }),
    ).rejects.toThrow(/conn refused/);
  });

  it("THROWS 'Campaign not found' when load-campaign returns null data with no error", async () => {
    const fake = wire({
      campaigns: { select: { data: null, error: null } },
    });
    const { step } = makeStep();

    await expect(
      runSendBatchGenerate({
        event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
        step: step as never,
        db: fake.db,
      }),
    ).rejects.toThrow(/Campaign not found/);
  });

  it("THROWS when create-batch insert errors", async () => {
    const fake = wire({
      campaigns: { select: { data: baseCampaign, error: null } },
      send_batches: { insert: { data: null, error: new Error("unique violation") } },
    });
    const { step } = makeStep();

    await expect(
      runSendBatchGenerate({
        event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
        step: step as never,
        db: fake.db,
      }),
    ).rejects.toThrow(/unique violation/);
  });

  it("THROWS 'Could not create send_batch' when insert returns null data with no error", async () => {
    const fake = wire({
      campaigns: { select: { data: baseCampaign, error: null } },
      send_batches: { insert: { data: null, error: null } },
    });
    const { step } = makeStep();

    await expect(
      runSendBatchGenerate({
        event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
        step: step as never,
        db: fake.db,
      }),
    ).rejects.toThrow(/Could not create send_batch/);
  });

  it("THROWS when create-approval insert errors", async () => {
    const fake = wire({
      campaigns: { select: { data: baseCampaign, error: null } },
      send_batches: { insert: { data: { id: "batch-1" }, error: null } },
      approvals_queue: { insert: { data: null, error: new Error("approvals down") } },
    });
    const { step } = makeStep();

    await expect(
      runSendBatchGenerate({
        event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
        step: step as never,
        db: fake.db,
      }),
    ).rejects.toThrow(/approvals down/);
  });

  it("on timeout: marks send_batches row failed AND returns {status:'timeout',batchId}", async () => {
    const fake = wire({
      campaigns: { select: { data: baseCampaign, error: null } },
      send_batches: { insert: { data: { id: "batch-99" }, error: null } },
      approvals_queue: { insert: { data: { id: "approval-99" }, error: null } },
    });
    const { step, calls, sentEvents } = makeStep(null);

    const out = await runSendBatchGenerate({
      event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
      step: step as never,
      db: fake.db,
    });

    expect(out).toEqual({ status: "timeout", batchId: "batch-99" });
    const writes = fake.recorded.update.send_batches!;
    expect(writes).toHaveLength(1);
    expect(writes[0]!.values).toMatchObject({ status: "failed" });
    expect(writes[0]!.eqArgs).toEqual([["id", "batch-99"]]);
    expect(captureServerEventMock).not.toHaveBeenCalled();
    // Locks step-ID uniqueness on the timeout branch — `mark-batch-failed`
    // must not collide with any happy-path id (e.g. `apply-decision`).
    assertUniqueStepIds(calls, sentEvents);
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
      db: fake.db,
    });

    expect(out).toMatchObject({ status: "edit", batchId: "batch-1" });
    expect(fake.recorded.update.send_batches![0]!.values).toMatchObject({ status: "approved" });
    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
  });

  it("emits sequence_activated when count returns null (production treats null as 0)", async () => {
    // Locks the `(count ?? 0) === 0` contract in sendBatch.ts:120 against a
    // Supabase quirk where the head-count query can resolve `count: null`
    // (e.g. driver returns null rows). Without this test, the funnel would
    // silently mis-fire if that branch ever activated.
    const fake = wire({
      campaigns: { select: { data: baseCampaign, error: null } },
      send_batches: {
        insert: { data: { id: "batch-null" }, error: null },
        count: { count: null, error: null },
      },
      approvals_queue: { insert: { data: { id: "approval-null" }, error: null } },
    });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await runSendBatchGenerate({
      event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
      step: step as never,
      db: fake.db,
    });

    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "cust-1",
      "sequence_activated",
      expect.objectContaining({ first_batch_id: "batch-null" }),
    );
  });

  it("propagates a funnel-emit failure so Inngest retries the step", async () => {
    const fake = wire({
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
        db: fake.db,
      }),
    ).rejects.toThrow(/posthog down/);
  });

  it("THROWS when apply-decision send_batches update returns an error", async () => {
    // A silent DB failure here would leave the batch in pending_approval while
    // the function reports success and sequence_activated would still fire.
    // The throw makes Inngest retry the step (≤3 attempts) and surfaces the
    // stuck-queue case in the Inngest run viewer.
    //
    // Ordering inside the apply-decision step (iter 14 `withOperatorApproval`):
    //   1. approvals_queue.update — succeeds first (helper owns it).
    //   2. onDecision side-effect → send_batches.update — throws here.
    // Inngest retries the whole step; both writes are idempotent (status
    // transitions to the same terminal value).
    const fake = wire({
      campaigns: { select: { data: baseCampaign, error: null } },
      send_batches: {
        insert: { data: { id: "batch-1" }, error: null },
        update: { data: null, error: new Error("batch update conflict") },
      },
      approvals_queue: {
        insert: { data: { id: "approval-1" }, error: null },
        update: { data: null, error: null },
      },
    });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runSendBatchGenerate({
        event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
        step: step as never,
        db: fake.db,
      }),
    ).rejects.toThrow(/batch update conflict/);
    // Apply-decision threw before the funnel emit could run.
    expect(captureServerEventMock).not.toHaveBeenCalled();
    // approvals_queue.update ran (and succeeded) before the throw; the throw
    // came from the downstream send_batches.update inside onDecision.
    expect(fake.recorded.update.approvals_queue ?? []).toHaveLength(1);
    expect(fake.recorded.update.approvals_queue![0]!.values).toMatchObject({
      status: "approved",
      operator_action: "approve",
    });
  });

  it("THROWS when apply-decision approvals_queue update returns an error", async () => {
    const fake = wire({
      campaigns: { select: { data: baseCampaign, error: null } },
      send_batches: {
        insert: { data: { id: "batch-1" }, error: null },
        update: { data: null, error: null },
      },
      approvals_queue: {
        insert: { data: { id: "approval-1" }, error: null },
        update: { data: null, error: new Error("approvals row locked") },
      },
    });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runSendBatchGenerate({
        event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
        step: step as never,
        db: fake.db,
      }),
    ).rejects.toThrow(/approvals row locked/);
    expect(captureServerEventMock).not.toHaveBeenCalled();
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
    return makeSupabaseFake(tables);
  }

  beforeEach(() => {
    // mockReset (not mockClear) so an unconsumed mockRejectedValueOnce from a
    // failing test cannot leak into the next test's queue; reapply the default
    // resolved-undefined impl after the reset.
    captureServerEventMock.mockReset();
    captureServerEventMock.mockImplementation(async () => undefined);
    runRewriteAgentMock.mockReset();
    runBrandVoiceAgentMock.mockReset();
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
    const fake = wire({ sequences: { select: { data: null, error: new Error("rls denied") } } });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
        db: fake.db,
      }),
    ).rejects.toThrow(/rls denied/);
  });

  it("THROWS 'Sequence not found' when load-sequence returns null data with no error", async () => {
    // Mirrors the symmetric sendBatch test. Production code paths after
    // load-sequence dereference `sequence.voice_profile_json` so a silent
    // null-data return would surface as an opaque TypeError; the explicit
    // throw keeps the failure mode aligned with the docstring contract.
    const fake = wire({ sequences: { select: { data: null, error: null } } });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
        db: fake.db,
      }),
    ).rejects.toThrow(/Sequence not found/);
  });

  it("THROWS 'Brand voice profile required' when sequence is missing voice_profile_json url/content", async () => {
    const fake = wire({
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
        db: fake.db,
      }),
    ).rejects.toThrow(/Brand voice profile required/);
    expect(runBrandVoiceAgentMock).not.toHaveBeenCalled();
  });

  it("THROWS 'Brand voice profile required' when runBrandVoiceAgent returns {ok:false}", async () => {
    const fake = wire({ sequences: { select: { data: baseSequence, error: null } } });
    runBrandVoiceAgentMock.mockResolvedValue({ ok: false, error: "scrape failed" });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
        db: fake.db,
      }),
    ).rejects.toThrow(/Brand voice profile required/);
  });

  it("THROWS 'ICP definition missing' when icp_json is null", async () => {
    const fake = wire({
      sequences: { select: { data: { ...baseSequence, icp_json: null }, error: null } },
    });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
        db: fake.db,
      }),
    ).rejects.toThrow(/ICP definition missing/);
    expect(runRewriteAgentMock).not.toHaveBeenCalled();
  });

  it("THROWS 'Rewrite Agent failed' when runRewriteAgent returns {ok:false}", async () => {
    const fake = wire({ sequences: { select: { data: baseSequence, error: null } } });
    runRewriteAgentMock.mockResolvedValue({ ok: false, error: "anthropic 429" });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
        db: fake.db,
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
      db: fake.db,
    });

    const writes = fake.recorded.update.sequences!;
    expect(writes).toHaveLength(2);
    const intermediate = writes[0]!;
    expect(intermediate.values).toMatchObject({ status: "pending_approval" });
    expect(intermediate.values.rewritten_text).toEqual(expect.stringContaining("Step 1"));
    expect(intermediate.values.rewritten_text).toEqual(expect.stringContaining("Subject: s"));
    expect(intermediate.eqArgs).toEqual([["id", "seq-1"]]);
  });

  it("THROWS when sequences update during create-approval errors", async () => {
    const fake = wire({
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
        db: fake.db,
      }),
    ).rejects.toThrow(/sequences locked/);
  });

  it("THROWS when approvals_queue insert errors", async () => {
    const fake = wire({
      sequences: { select: { data: baseSequence, error: null } },
      approvals_queue: { insert: { data: null, error: new Error("approvals down") } },
    });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
        db: fake.db,
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
      db: fake.db,
    });

    expect(out.status).toBe("edit");
    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
    expect(fake.recorded.update.approvals_queue![0]!.values).toMatchObject({ status: "approved" });
  });

  it("propagates a funnel-emit failure so Inngest retries the step", async () => {
    const fake = wire({
      sequences: { select: { data: baseSequence, error: null } },
      approvals_queue: { insert: { data: { id: "approval-1" }, error: null } },
    });
    captureServerEventMock.mockRejectedValueOnce(new Error("posthog down"));
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
        db: fake.db,
      }),
    ).rejects.toThrow(/posthog down/);
  });

  it("THROWS when apply-decision approvals_queue update returns an error", async () => {
    // A silent DB failure here would leave the row in pending_approval while
    // the function reports success and rewrite_approved would still fire. The
    // throw makes Inngest retry the step (≤3 attempts) and surfaces the
    // stuck-queue case in the Inngest run viewer.
    const fake = wire({
      sequences: { select: { data: baseSequence, error: null } },
      approvals_queue: {
        insert: { data: { id: "approval-1" }, error: null },
        update: { data: null, error: new Error("approvals row locked") },
      },
    });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
        db: fake.db,
      }),
    ).rejects.toThrow(/approvals row locked/);
    expect(captureServerEventMock).not.toHaveBeenCalled();
    // sequences update never ran because approvals_queue update threw first.
    // (Both apply-decision updates are isolated from the intermediate write,
    // which writes rewritten_text and runs in create-approval — that has
    // already succeeded by the time the failing update fires.)
    expect(
      (fake.recorded.update.sequences ?? []).filter((w) =>
        Object.keys(w.values).includes("approved_at"),
      ),
    ).toEqual([]);
  });

  it("THROWS when apply-decision sequences update returns an error (per-call config isolates from intermediate)", async () => {
    // The sequences table is updated twice in the success path:
    //   1. create-approval step: writes rewritten_text + status='pending_approval'
    //   2. apply-decision step:  writes status='approved' + approved_at
    // Use the function-form update config to fail ONLY the apply-decision
    // write — proves the second update's error is surfaced, not swallowed.
    const fake = wire({
      sequences: {
        select: { data: baseSequence, error: null },
        update: (values) =>
          "approved_at" in values
            ? { data: null, error: new Error("sequences approved_at write failed") }
            : { data: null, error: null },
      },
      approvals_queue: { insert: { data: { id: "approval-1" }, error: null } },
    });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runOnboardingPipeline({
        event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
        step: step as never,
        db: fake.db,
      }),
    ).rejects.toThrow(/sequences approved_at write failed/);
    expect(captureServerEventMock).not.toHaveBeenCalled();
    // Both updates were attempted (intermediate succeeded, apply-decision failed).
    expect(fake.recorded.update.sequences).toHaveLength(2);
    expect(fake.recorded.update.sequences![0]!.values).toMatchObject({
      status: "pending_approval",
    });
    expect(fake.recorded.update.sequences![1]!.values).toMatchObject({
      status: "approved",
    });
  });
});

// ----------------------------------------------------------------- performance

describe("performanceDailyPull — error paths + edge cases", () => {
  function wire(tables: Record<string, TableConfig>) {
    return makeSupabaseFake(tables);
  }

  beforeEach(() => {
    // mockReset (not mockClear) so an unconsumed mockRejectedValueOnce from a
    // failing test cannot leak into the next test's queue; reapply the default
    // resolved-undefined impl after the reset.
    captureServerEventMock.mockReset();
    captureServerEventMock.mockImplementation(async () => undefined);
    getCampaignMetricsMock.mockReset();
    computePerformanceMock.mockReset();
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
    const fake = wire({ campaigns: { pages: { pageSize: 200, pages: [[]] } } });
    const { step } = makeStep();

    const out = await runPerformanceDailyPull({ step: step as never, db: fake.db });

    expect(out).toEqual({ processed: 0, results: [] });
    expect(getCampaignMetricsMock).not.toHaveBeenCalled();
    expect(captureServerEventMock).not.toHaveBeenCalled();
    // Locks the early-termination contract: a single empty page must not
    // trigger a second range read.
    expect(fake.recorded.rangeCalls.campaigns).toEqual([[0, 199]]);
  });

  it.each([
    ["abc", null],
    ["", null],
    ["0", null],
    ["100.5", null],
    ["-5", null],
    ["123abc", null], // parseInt trailing-garbage trap
    ["1e3", null], // scientific notation must not slip through
    [" 12 ", null], // whitespace must not slip through
    ["100", 100],
    ["1", 1],
  ])("parseSmartleadCampaignId(%j) === %j", (raw, expected) => {
    expect(parseSmartleadCampaignId(raw)).toBe(expected);
  });

  it("skips a campaign whose smartlead_campaign_id has trailing garbage ('123abc')", async () => {
    // Regression: Number.parseInt("123abc",10) === 123 — the old guard
    // accepted this and silently pulled metrics for campaign 123. The strict
    // parser must reject it.
    const fake = wire({
      campaigns: {
        pages: {
          pageSize: 200,
          pages: [
            [
              {
                id: "camp-trailing",
                customer_id: "cust-trailing",
                smartlead_campaign_id: "123abc",
                started_at: "2026-04-01T00:00:00Z",
              },
            ],
          ],
        },
      },
    });
    const { step } = makeStep();

    const out = await runPerformanceDailyPull({ step: step as never, db: fake.db });

    expect(out).toEqual({ processed: 0, results: [] });
    expect(getCampaignMetricsMock).not.toHaveBeenCalled();
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });

  it("skips a campaign whose smartlead_campaign_id is non-numeric (e.g. 'abc')", async () => {
    const fake = wire({
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

    const out = await runPerformanceDailyPull({ step: step as never, db: fake.db });

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

    const out = await runPerformanceDailyPull({ step: step as never, db: fake.db });

    expect(out.processed).toBe(0);
    expect(fake.recorded.rangeCalls.campaigns).toEqual([
      [0, 199],
      [200, 399],
    ]);
  });

  it("uses days=0 when started_at is null (no past date math)", async () => {
    const fake = wire({
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

    await runPerformanceDailyPull({ step: step as never, db: fake.db });

    expect(computePerformanceMock).toHaveBeenCalledTimes(1);
    expect(computePerformanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ days_since_start: 0 }),
    );
  });

  it("THROWS when performance_snapshots upsert returns an error (so Inngest retries)", async () => {
    const fake = wire({
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

    await expect(
      runPerformanceDailyPull({ step: step as never, db: fake.db }),
    ).rejects.toThrow(/snapshot write failed/);
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });

  it("propagates a funnel-emit failure so Inngest retries the step", async () => {
    const fake = wire({
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

    await expect(
      runPerformanceDailyPull({ step: step as never, db: fake.db }),
    ).rejects.toThrow(/posthog down/);
  });
});

// -------------------------------------------------- cross-cutting: step-ID uniqueness
//
// Inngest requires step ids to be unique within a single function invocation;
// duplicates are a latent prod bug (re-entry on the same id is silently
// elided). Lock this contract across all three functions' happy paths so a
// future caller that copies-and-pastes a step id surfaces immediately.

describe("step-ID uniqueness across happy paths", () => {
  beforeEach(() => {
    captureServerEventMock.mockReset();
    captureServerEventMock.mockImplementation(async () => undefined);
    runRewriteAgentMock.mockReset();
    runBrandVoiceAgentMock.mockReset();
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
    runRewriteAgentMock.mockResolvedValue({
      ok: true,
      result: {
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
      },
    });
    getCampaignMetricsMock.mockReset();
    computePerformanceMock.mockReset();
    getCampaignMetricsMock.mockResolvedValue({ sent: 100, unique_opens: 50, replies: 5 });
    computePerformanceMock.mockImplementation(({ campaign_id, customer_id }) => ({
      campaign_id,
      customer_id,
      current_reply_rate: 0.05,
      uplift_pct: 12,
      trigger_free_rewrite: false,
    }));
  });

  it("sendBatchGenerate happy path emits no duplicate step ids", async () => {
    const fake = makeSupabaseFake({
      campaigns: {
        select: {
          data: {
            id: "camp-1",
            customer_id: "cust-1",
            sequence_id: "seq-1",
            daily_cap: 50,
            status: "sending",
            smartlead_campaign_id: "sl-1",
          },
          error: null,
        },
      },
      send_batches: {
        insert: { data: { id: "batch-1" }, error: null },
        count: { count: 0, error: null },
      },
      approvals_queue: { insert: { data: { id: "approval-1" }, error: null } },
    });
    const { step, calls, sentEvents } = makeStep({
      data: { decision: "approve", notes: null },
    });

    await runSendBatchGenerate({
      event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
      step: step as never,
      db: fake.db,
    });

    assertUniqueStepIds(calls, sentEvents);
  });

  it("onboardingPipeline happy path emits no duplicate step ids", async () => {
    const fake = makeSupabaseFake({
      sequences: {
        select: {
          data: {
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
          },
          error: null,
        },
      },
      approvals_queue: { insert: { data: { id: "approval-1" }, error: null } },
    });
    const { step, calls, sentEvents } = makeStep({
      data: { decision: "approve", notes: null },
    });

    await runOnboardingPipeline({
      event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
      step: step as never,
      db: fake.db,
    });

    assertUniqueStepIds(calls, sentEvents);
  });

  it("performanceDailyPull happy path emits no duplicate step ids", async () => {
    const fake = makeSupabaseFake({
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
              {
                id: "camp-B",
                customer_id: "cust-B",
                smartlead_campaign_id: "200",
                started_at: "2026-04-01T00:00:00Z",
              },
            ],
          ],
        },
      },
    });
    const { step, calls, sentEvents } = makeStep();

    await runPerformanceDailyPull({ step: step as never, db: fake.db });

    // Per-campaign step ids must include the campaign id so two campaigns in
    // the same run don't collide on `pull-metrics` / `upsert-snapshot` /
    // emission ids.
    assertUniqueStepIds(calls, sentEvents);
  });
});
