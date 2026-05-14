if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) process.env.SUPABASE_SERVICE_ROLE_KEY = "test-supabase-key";
if (!process.env.STRIPE_SECRET_KEY) process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
if (!process.env.STRIPE_WEBHOOK_SECRET) process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy";
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { captureServerEventMock, serviceClientMock, runRewriteAgentMock, runBrandVoiceAgentMock, getCampaignMetricsMock, computePerformanceMock } = vi.hoisted(() => ({
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

// --- helpers --------------------------------------------------------------

type StepRunCall = { id: string; fn: () => unknown };

/**
 * Build a fake Inngest `step` that runs `step.run` callbacks inline (so we can
 * assert call args + side effects) and records each step id for uniqueness
 * checks. `waitForEventReturn` controls what waitForEvent resolves to.
 */
function makeStep(waitForEventReturn: unknown = null) {
  const calls: StepRunCall[] = [];
  const sentEvents: Array<{ id: string; payload: object }> = [];
  const step = {
    run: vi.fn(async (id: string, fn: () => unknown) => {
      calls.push({ id, fn });
      return fn();
    }),
    waitForEvent: vi.fn(async () => waitForEventReturn),
    sendEvent: vi.fn(async (id: string, payload: object) => {
      sentEvents.push({ id, payload });
      return undefined;
    }),
  };
  return { step, calls, sentEvents };
}

/**
 * Build a chainable Supabase query-builder stub. `final` is what awaiting the
 * builder resolves to (e.g. `{ data, error, count }`). All chain methods return
 * the builder itself so .eq().select().single() etc. work.
 */
function makeQuery(final: { data?: unknown; error?: unknown; count?: number | null }) {
  const builder: any = {
    select: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    update: vi.fn(() => builder),
    upsert: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    neq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    single: vi.fn(async () => final),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(final).then(resolve),
  };
  return builder;
}

// --- onboardingPipeline funnel: rewrite_approved --------------------------

describe("onboardingPipeline funnel emission (rewrite_approved)", () => {
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
      { step: 1, purpose: "open", send_delay_days: 0, subject: "s", body: "b", personalisation_tokens: [], diff_summary: "d", new_claims: [] },
    ],
    playbook_used: "p",
    expected_reply_rate_band: "4-7%",
    guardrail_flags: [],
    rationale: "r",
  };

  beforeEach(() => {
    captureServerEventMock.mockClear();
    runRewriteAgentMock.mockReset();
    runBrandVoiceAgentMock.mockReset();
    serviceClientMock.mockReset();

    runBrandVoiceAgentMock.mockResolvedValue({ ok: true, result: { tone: ["plain"], positioning: "p", key_phrases: [], avoid_phrases: [], reading_level: "professional", source_urls: ["https://acme.example"] } });
    runRewriteAgentMock.mockResolvedValue({ ok: true, result: rewriteResult });

    serviceClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "sequences") return makeQuery({ data: baseSequence, error: null });
        if (table === "approvals_queue") return makeQuery({ data: { id: "approval-1" }, error: null });
        return makeQuery({ data: null, error: null });
      }),
    });
  });

  afterEach(() => vi.clearAllMocks());

  it("emits rewrite_approved with correct payload when operator approves", async () => {
    const { step, calls } = makeStep({ data: { decision: "approve", notes: null } });

    const out = await runOnboardingPipeline({
      event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
      step: step as any,
    });

    expect(out.status).toBe("approve");
    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventMock).toHaveBeenCalledWith("cust-1", "rewrite_approved", {
      sequence_id: "seq-1",
      approval_id: "approval-1",
      decision: "approve",
    });
    // Step id must match the funnel-emit step
    const emitCall = calls.find((c) => c.id === "emit-rewrite-approved-funnel");
    expect(emitCall).toBeTruthy();
  });

  it("DOES NOT emit rewrite_approved when operator rejects", async () => {
    const { step, calls } = makeStep({ data: { decision: "reject", notes: "off-brand" } });

    const out = await runOnboardingPipeline({
      event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
      step: step as any,
    });

    expect(out.status).toBe("reject");
    expect(captureServerEventMock).not.toHaveBeenCalled();
    expect(calls.find((c) => c.id === "emit-rewrite-approved-funnel")).toBeUndefined();
  });

  it("DOES NOT emit rewrite_approved on approval timeout", async () => {
    const { step } = makeStep(null); // waitForEvent returns null = timeout

    const out = await runOnboardingPipeline({
      event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
      step: step as any,
    });

    expect(out.status).toBe("timeout");
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });
});

// --- sendBatchGenerate funnel: sequence_activated -------------------------

describe("sendBatchGenerate funnel emission (sequence_activated)", () => {
  const baseCampaign = {
    id: "camp-1",
    customer_id: "cust-1",
    sequence_id: "seq-1",
    daily_cap: 50,
    status: "sending",
    smartlead_campaign_id: "sl-1",
  };

  type BatchScenario = {
    countResult: { count: number | null; error: unknown };
    decision?: { decision: string; notes?: string | null } | null;
  };

  function setupClient(scenario: BatchScenario) {
    serviceClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "campaigns") return makeQuery({ data: baseCampaign, error: null });
        if (table === "send_batches") {
          // First call (create-batch) uses .insert().select().single() — return new id
          // Subsequent call (count-prior-approved-batches) uses .select with head:true
          // The chained builder is identical; we differentiate by side-channel state below.
          return makeQuery({ data: { id: "batch-1" }, error: null, count: scenario.countResult.count } as any);
        }
        if (table === "approvals_queue") return makeQuery({ data: { id: "approval-1" }, error: null });
        return makeQuery({ data: null, error: null });
      }),
    });
  }

  beforeEach(() => {
    captureServerEventMock.mockClear();
    serviceClientMock.mockReset();
  });

  it("emits sequence_activated when count of prior approved batches is 0", async () => {
    // Counts: we need the *count-prior* query to return count=0. With the unified
    // makeQuery above the count is fixed; we'll wire a smarter mock that returns
    // count=0 specifically when .neq is used.
    const client = {
      from: vi.fn((table: string) => {
        if (table === "campaigns") return makeQuery({ data: baseCampaign, error: null });
        if (table === "approvals_queue") return makeQuery({ data: { id: "approval-1" }, error: null });
        if (table === "send_batches") {
          // Differentiate by which methods are called: count-prior-approved-batches
          // uses .neq("id", ...). Create-batch uses .insert. So return a builder
          // that responds based on the chain used.
          const builder: any = {
            _kind: undefined,
            select: vi.fn((_cols?: string, opts?: { count?: string; head?: boolean }) => {
              if (opts?.head) builder._kind = "count";
              return builder;
            }),
            insert: vi.fn(() => {
              builder._kind = "insert";
              return builder;
            }),
            update: vi.fn(() => builder),
            eq: vi.fn(() => builder),
            neq: vi.fn(() => builder),
            single: vi.fn(async () => ({ data: { id: "batch-1" }, error: null })),
            then: (resolve: (v: unknown) => unknown) => {
              if (builder._kind === "count") return Promise.resolve({ count: 0, error: null }).then(resolve);
              return Promise.resolve({ data: { id: "batch-1" }, error: null }).then(resolve);
            },
          };
          return builder;
        }
        return makeQuery({ data: null, error: null });
      }),
    };
    serviceClientMock.mockReturnValue(client);

    const { step } = makeStep({ data: { decision: "approve", notes: null } });
    await runSendBatchGenerate({
      event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
      step: step as any,
    });

    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventMock).toHaveBeenCalledWith("cust-1", "sequence_activated", {
      campaign_id: "camp-1",
      sequence_id: "seq-1",
      first_batch_id: "batch-1",
      batch_date: "2026-05-14",
    });
  });

  it("DOES NOT emit sequence_activated when this is the 2nd+ approved batch", async () => {
    serviceClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "campaigns") return makeQuery({ data: baseCampaign, error: null });
        if (table === "approvals_queue") return makeQuery({ data: { id: "approval-1" }, error: null });
        if (table === "send_batches") {
          const builder: any = {
            _kind: undefined,
            select: vi.fn((_cols?: string, opts?: { count?: string; head?: boolean }) => {
              if (opts?.head) builder._kind = "count";
              return builder;
            }),
            insert: vi.fn(() => builder),
            update: vi.fn(() => builder),
            eq: vi.fn(() => builder),
            neq: vi.fn(() => builder),
            single: vi.fn(async () => ({ data: { id: "batch-2" }, error: null })),
            then: (resolve: (v: unknown) => unknown) => {
              if (builder._kind === "count") return Promise.resolve({ count: 3, error: null }).then(resolve);
              return Promise.resolve({ data: { id: "batch-2" }, error: null }).then(resolve);
            },
          };
          return builder;
        }
        return makeQuery({ data: null, error: null });
      }),
    });

    const { step } = makeStep({ data: { decision: "approve", notes: null } });
    await runSendBatchGenerate({
      event: { data: { campaign_id: "camp-1", batch_date: "2026-05-15" } },
      step: step as any,
    });

    expect(captureServerEventMock).not.toHaveBeenCalled();
  });

  it("DOES NOT emit sequence_activated when operator rejects", async () => {
    setupClient({ countResult: { count: 0, error: null } });

    const { step } = makeStep({ data: { decision: "reject", notes: "off-brand" } });
    await runSendBatchGenerate({
      event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
      step: step as any,
    });

    expect(captureServerEventMock).not.toHaveBeenCalled();
  });

  it("DOES NOT emit sequence_activated when count query errors (fail-closed)", async () => {
    serviceClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "campaigns") return makeQuery({ data: baseCampaign, error: null });
        if (table === "approvals_queue") return makeQuery({ data: { id: "approval-1" }, error: null });
        if (table === "send_batches") {
          const builder: any = {
            _kind: undefined,
            select: vi.fn((_cols?: string, opts?: { count?: string; head?: boolean }) => {
              if (opts?.head) builder._kind = "count";
              return builder;
            }),
            insert: vi.fn(() => builder),
            update: vi.fn(() => builder),
            eq: vi.fn(() => builder),
            neq: vi.fn(() => builder),
            single: vi.fn(async () => ({ data: { id: "batch-1" }, error: null })),
            then: (resolve: (v: unknown) => unknown) => {
              if (builder._kind === "count")
                return Promise.resolve({ count: null, error: new Error("db down") }).then(resolve);
              return Promise.resolve({ data: { id: "batch-1" }, error: null }).then(resolve);
            },
          };
          return builder;
        }
        return makeQuery({ data: null, error: null });
      }),
    });

    const { step } = makeStep({ data: { decision: "approve", notes: null } });
    await runSendBatchGenerate({
      event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
      step: step as any,
    });

    // The error branch returns `false` for isFirstApproved -> no emission
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });
});

// --- performanceDailyPull funnel: performance_report_sent -----------------

describe("performanceDailyPull funnel emission (performance_report_sent)", () => {
  beforeEach(() => {
    captureServerEventMock.mockClear();
    getCampaignMetricsMock.mockReset();
    computePerformanceMock.mockReset();
    serviceClientMock.mockReset();
  });

  it("emits one performance_report_sent per active campaign with payload-shape correct", async () => {
    const campaigns = [
      { id: "camp-A", customer_id: "cust-A", smartlead_campaign_id: "100", started_at: "2026-04-01T00:00:00Z" },
      { id: "camp-B", customer_id: "cust-B", smartlead_campaign_id: "200", started_at: "2026-04-15T00:00:00Z" },
    ];
    serviceClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "campaigns") return makeQuery({ data: campaigns, error: null });
        if (table === "performance_snapshots") return makeQuery({ data: null, error: null });
        return makeQuery({ data: null, error: null });
      }),
    });
    getCampaignMetricsMock.mockResolvedValue({ sent: 100, unique_opens: 50, replies: 5 });
    computePerformanceMock.mockImplementation(({ campaign_id, customer_id }) => ({
      campaign_id,
      customer_id,
      current_reply_rate: 0.05,
      uplift_pct: 12,
      trigger_free_rewrite: false,
    }));

    const { step, calls } = makeStep();
    await runPerformanceDailyPull({ step: step as any });

    expect(captureServerEventMock).toHaveBeenCalledTimes(2);

    // Per-campaign customer_id correctness
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "cust-A",
      "performance_report_sent",
      expect.objectContaining({
        campaign_id: "camp-A",
        current_reply_rate: 0.05,
        uplift_pct: 12,
      }),
    );
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "cust-B",
      "performance_report_sent",
      expect.objectContaining({
        campaign_id: "camp-B",
        current_reply_rate: 0.05,
        uplift_pct: 12,
      }),
    );

    // Payload includes snapshot_date in YYYY-MM-DD form
    for (const call of captureServerEventMock.mock.calls) {
      const props = (call as unknown as [string, string, { snapshot_date: string }])[2];
      expect(props.snapshot_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    // Step IDs in the loop must be unique per campaign (Inngest enforces this).
    const emitIds = calls.filter((c) => c.id.startsWith("emit-perf-report-funnel-")).map((c) => c.id);
    expect(new Set(emitIds).size).toBe(emitIds.length);
    expect(emitIds).toEqual(["emit-perf-report-funnel-camp-A", "emit-perf-report-funnel-camp-B"]);
  });

  it("skips campaigns missing smartlead_campaign_id and emits no event for them", async () => {
    const campaigns = [
      { id: "camp-A", customer_id: "cust-A", smartlead_campaign_id: null, started_at: "2026-04-01T00:00:00Z" },
      { id: "camp-B", customer_id: "cust-B", smartlead_campaign_id: "200", started_at: "2026-04-15T00:00:00Z" },
    ];
    serviceClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "campaigns") return makeQuery({ data: campaigns, error: null });
        return makeQuery({ data: null, error: null });
      }),
    });
    getCampaignMetricsMock.mockResolvedValue({ sent: 100, unique_opens: 50, replies: 5 });
    computePerformanceMock.mockImplementation(({ campaign_id, customer_id }) => ({
      campaign_id,
      customer_id,
      current_reply_rate: 0.05,
      uplift_pct: 12,
      trigger_free_rewrite: false,
    }));

    const { step } = makeStep();
    await runPerformanceDailyPull({ step: step as any });

    // Only camp-B emits
    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "cust-B",
      "performance_report_sent",
      expect.objectContaining({ campaign_id: "camp-B" }),
    );
  });
});
