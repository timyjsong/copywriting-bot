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
  // Real format — must match production `funnelInsertId` so the dedup-key
  // assertions pin the actual `$insert_id` PostHog sees, not a fake echo.
  funnelInsertId: (event: string, key: string) => `${event}:${key}`,
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
  const sentEvents: Array<{ id: string; payload: { name: string; data: object } }> = [];
  const step = {
    run: vi.fn(async (id: string, fn: () => unknown) => {
      calls.push({ id, fn });
      return fn();
    }),
    waitForEvent: vi.fn(async () => waitForEventReturn),
    sendEvent: vi.fn(async (id: string, payload: { name: string; data: object }) => {
      sentEvents.push({ id, payload });
      return undefined;
    }),
  };
  return { step, calls, sentEvents };
}

/**
 * Asserts that all `step.run`/`step.sendEvent` ids are unique. Inngest
 * enforces this at runtime, so any duplicate is a latent prod bug.
 */
function assertUniqueStepIds(calls: StepRunCall[], sentEvents: Array<{ id: string }>) {
  const ids = [...calls.map((c) => c.id), ...sentEvents.map((e) => e.id)];
  expect(new Set(ids).size).toBe(ids.length);
}

/**
 * Chainable Supabase query-builder stub for "simple" tables. Awaiting it
 * resolves to `final`; .single() also resolves to `final`. Records each call
 * so tests can assert what columns/values were written.
 */
type QueryBuilder = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  neq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  range: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  then: (resolve: (v: unknown) => unknown) => Promise<unknown>;
};

function makeQuery(final: { data?: unknown; error?: unknown; count?: number | null }): QueryBuilder {
  const builder: QueryBuilder = {
    select: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    update: vi.fn(() => builder),
    upsert: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    neq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    order: vi.fn(() => builder),
    range: vi.fn(() => builder),
    single: vi.fn(async () => final),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(final).then(resolve),
  };
  return builder;
}

/**
 * Mock for the paginated `campaigns` table fetched by performanceDailyPull.
 * Each call to `.from("campaigns")` returns a fresh builder, but the page
 * counter is hoisted on the closure so successive `.range(from,to)` reads
 * advance through `pages`. Once exhausted, every subsequent call returns
 * an empty array (terminating the while-loop in production code).
 */
function makePaginatedCampaignsMock(pages: Array<Array<{ id: string; customer_id: string; smartlead_campaign_id: string | null; started_at: string | null }>>) {
  let pageIdx = 0;
  const rangeCalls: Array<[number, number]> = [];
  function next() {
    const builder: any = {
      select: vi.fn(() => builder),
      in: vi.fn(() => builder),
      order: vi.fn(() => builder),
      range: vi.fn((from: number, to: number) => {
        rangeCalls.push([from, to]);
        return builder;
      }),
      then: (resolve: (v: unknown) => unknown) => {
        const page = pages[pageIdx] ?? [];
        pageIdx += 1;
        return Promise.resolve({ data: page, error: null }).then(resolve);
      },
    };
    return builder;
  }
  return { next, rangeCalls, get pageIdx() { return pageIdx; } };
}

/**
 * send_batches needs a typed fake that discriminates by which chain methods
 * were called rather than by an undocumented `_kind` side-channel. We model
 * the two real query shapes explicitly:
 *
 *   - insert(...).select(...).single()           → returns `insertResult`
 *   - select(..., {head:true,count:'exact'})...  → returns `{ count, error }`
 *
 * Test asserts which shape was used so prod reordering can't quietly flip
 * the test into the wrong branch.
 */
function makeSendBatchesFake(opts: {
  insertResult: { data: { id: string } | null; error: unknown };
  countResult: { count: number | null; error: unknown };
}) {
  const insertCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<{ values: Record<string, unknown>; eqArgs: Array<[string, unknown]> }> = [];
  const countQueryCalls: Array<{ eqArgs: Array<[string, unknown]>; neqArgs: Array<[string, unknown]> }> = [];

  function build(): QueryBuilder & { __mode?: "insert" | "update" | "count" | "unknown" } {
    let mode: "insert" | "update" | "count" | "unknown" = "unknown";
    let pendingUpdate: Record<string, unknown> | null = null;
    const eqArgs: Array<[string, unknown]> = [];
    const neqArgs: Array<[string, unknown]> = [];

    const builder = {
      __mode: mode,
      select: vi.fn((_cols?: string, options?: { count?: string; head?: boolean }) => {
        if (options?.head && options?.count === "exact") mode = "count";
        return builder;
      }),
      insert: vi.fn((values: Record<string, unknown>) => {
        mode = "insert";
        insertCalls.push(values);
        return builder;
      }),
      update: vi.fn((values: Record<string, unknown>) => {
        mode = "update";
        pendingUpdate = values;
        return builder;
      }),
      upsert: vi.fn(() => builder),
      eq: vi.fn((col: string, val: unknown) => {
        eqArgs.push([col, val]);
        return builder;
      }),
      neq: vi.fn((col: string, val: unknown) => {
        neqArgs.push([col, val]);
        return builder;
      }),
      in: vi.fn(() => builder),
      order: vi.fn(() => builder),
      range: vi.fn(() => builder),
      single: vi.fn(async () => opts.insertResult),
      then: (resolve: (v: unknown) => unknown) => {
        if (mode === "count") {
          countQueryCalls.push({ eqArgs, neqArgs });
          return Promise.resolve(opts.countResult).then(resolve);
        }
        if (mode === "update") {
          updateCalls.push({ values: pendingUpdate ?? {}, eqArgs });
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }
        if (mode === "insert") {
          return Promise.resolve(opts.insertResult).then(resolve);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    } as QueryBuilder & { __mode?: typeof mode };

    return builder;
  }

  // Each .from('send_batches') call returns a fresh builder (mirroring the
  // real Supabase client which builds a new query per call). Captured arrays
  // persist across builders so tests can inspect the full sequence.
  return {
    next: build,
    insertCalls,
    updateCalls,
    countQueryCalls,
  };
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

  // Captured-write tracking; re-bound in beforeEach so each test starts clean.
  let approvalsUpdateCalls: Array<{ values: Record<string, unknown>; eqArgs: Array<[string, unknown]> }>;
  let sequencesUpdateCalls: Array<{ values: Record<string, unknown>; eqArgs: Array<[string, unknown]> }>;

  beforeEach(() => {
    captureServerEventMock.mockClear();
    runRewriteAgentMock.mockReset();
    runBrandVoiceAgentMock.mockReset();
    serviceClientMock.mockReset();
    approvalsUpdateCalls = [];
    sequencesUpdateCalls = [];

    runBrandVoiceAgentMock.mockResolvedValue({ ok: true, result: { tone: ["plain"], positioning: "p", key_phrases: [], avoid_phrases: [], reading_level: "professional", source_urls: ["https://acme.example"] } });
    runRewriteAgentMock.mockResolvedValue({ ok: true, result: rewriteResult });

    serviceClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "sequences") {
          // load-sequence uses .select().eq().single() → return baseSequence.
          // apply-decision uses .update({...}).eq("id", ...) → capture the write.
          let mode: "select" | "update" = "select";
          let pendingUpdate: Record<string, unknown> | null = null;
          const eqArgs: Array<[string, unknown]> = [];
          const builder: any = {
            select: vi.fn(() => {
              mode = "select";
              return builder;
            }),
            update: vi.fn((values: Record<string, unknown>) => {
              mode = "update";
              pendingUpdate = values;
              return builder;
            }),
            eq: vi.fn((col: string, val: unknown) => {
              eqArgs.push([col, val]);
              return builder;
            }),
            single: vi.fn(async () => ({ data: baseSequence, error: null })),
            then: (resolve: (v: unknown) => unknown) => {
              if (mode === "update") {
                sequencesUpdateCalls.push({ values: pendingUpdate ?? {}, eqArgs });
                return Promise.resolve({ data: null, error: null }).then(resolve);
              }
              return Promise.resolve({ data: baseSequence, error: null }).then(resolve);
            },
          };
          return builder;
        }
        if (table === "approvals_queue") {
          let mode: "insert" | "update" = "insert";
          let pendingUpdate: Record<string, unknown> | null = null;
          const eqArgs: Array<[string, unknown]> = [];
          const builder: any = {
            select: vi.fn(() => builder),
            insert: vi.fn(() => {
              mode = "insert";
              return builder;
            }),
            update: vi.fn((values: Record<string, unknown>) => {
              mode = "update";
              pendingUpdate = values;
              return builder;
            }),
            eq: vi.fn((col: string, val: unknown) => {
              eqArgs.push([col, val]);
              return builder;
            }),
            single: vi.fn(async () => ({ data: { id: "approval-1" }, error: null })),
            then: (resolve: (v: unknown) => unknown) => {
              if (mode === "update") {
                approvalsUpdateCalls.push({ values: pendingUpdate ?? {}, eqArgs });
                return Promise.resolve({ data: null, error: null }).then(resolve);
              }
              return Promise.resolve({ data: { id: "approval-1" }, error: null }).then(resolve);
            },
          };
          return builder;
        }
        return makeQuery({ data: null, error: null });
      }),
    });
  });

  afterEach(() => vi.clearAllMocks());

  it("emits rewrite_approved with correct payload AND persists status=approved when operator approves", async () => {
    const { step, calls, sentEvents } = makeStep({ data: { decision: "approve", notes: null } });

    const out = await runOnboardingPipeline({
      event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
      step: step as any,
    });

    expect(out.status).toBe("approve");
    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
    // `$insert_id` keyed on approval_id locks the dedup contract — Inngest
    // retries of this emit-step must reproduce the identical key so PostHog
    // dedupes within its 24h window. Iter 24 closed the last server-emitted
    // funnel events that lacked this stamping.
    expect(captureServerEventMock).toHaveBeenCalledWith("cust-1", "rewrite_approved", {
      sequence_id: "seq-1",
      approval_id: "approval-1",
      decision: "approve",
      $insert_id: "rewrite_approved:approval-1",
    });
    expect(calls.find((c) => c.id === "emit-rewrite-approved-funnel")).toBeTruthy();
    assertUniqueStepIds(calls, sentEvents);

    // Persistence side-effects: approvals_queue gets status=approved + operator_*
    expect(approvalsUpdateCalls).toHaveLength(1);
    const approvalWrite = approvalsUpdateCalls[0]!;
    expect(approvalWrite.values).toMatchObject({
      status: "approved",
      operator_action: "approve",
      operator_notes: null,
    });
    expect(approvalWrite.values.decided_at).toEqual(expect.any(String));
    expect(approvalWrite.eqArgs).toEqual([["id", "approval-1"]]);

    // sequences row updated to status=approved with approved_at timestamp
    const sequenceFinalWrite = sequencesUpdateCalls.find((w) => w.values.status === "approved");
    expect(sequenceFinalWrite).toBeTruthy();
    expect(sequenceFinalWrite!.values.approved_at).toEqual(expect.any(String));
    expect(sequenceFinalWrite!.eqArgs).toEqual([["id", "seq-1"]]);
  });

  it("DOES NOT emit rewrite_approved AND persists status=rejected when operator rejects", async () => {
    const { step, calls, sentEvents } = makeStep({ data: { decision: "reject", notes: "off-brand" } });

    const out = await runOnboardingPipeline({
      event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
      step: step as any,
    });

    expect(out.status).toBe("reject");
    expect(captureServerEventMock).not.toHaveBeenCalled();
    expect(calls.find((c) => c.id === "emit-rewrite-approved-funnel")).toBeUndefined();
    assertUniqueStepIds(calls, sentEvents);

    // Persistence side-effects: rejection must still be recorded
    expect(approvalsUpdateCalls).toHaveLength(1);
    expect(approvalsUpdateCalls[0]!.values).toMatchObject({
      status: "rejected",
      operator_action: "reject",
      operator_notes: "off-brand",
    });
    const sequenceFinalWrite = sequencesUpdateCalls.find((w) => w.values.status === "rejected");
    expect(sequenceFinalWrite).toBeTruthy();
  });

  it("DOES NOT emit rewrite_approved on approval timeout", async () => {
    const { step, calls, sentEvents } = makeStep(null);

    const out = await runOnboardingPipeline({
      event: { data: { customer_id: "cust-1", sequence_id: "seq-1" } },
      step: step as any,
    });

    expect(out.status).toBe("timeout");
    expect(captureServerEventMock).not.toHaveBeenCalled();
    // No apply-decision call on timeout
    expect(approvalsUpdateCalls).toHaveLength(0);
    assertUniqueStepIds(calls, sentEvents);
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

  function wireClient(opts: {
    insertResult?: { data: { id: string } | null; error: unknown };
    countResult: { count: number | null; error: unknown };
  }) {
    const fake = makeSendBatchesFake({
      insertResult: opts.insertResult ?? { data: { id: "batch-1" }, error: null },
      countResult: opts.countResult,
    });
    const approvalsUpdateCalls: Array<{ values: Record<string, unknown>; eqArgs: Array<[string, unknown]> }> = [];

    serviceClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "campaigns") return makeQuery({ data: baseCampaign, error: null });
        if (table === "send_batches") return fake.next();
        if (table === "approvals_queue") {
          let mode: "insert" | "update" = "insert";
          let pendingUpdate: Record<string, unknown> | null = null;
          const eqArgs: Array<[string, unknown]> = [];
          const builder: any = {
            select: vi.fn(() => builder),
            insert: vi.fn(() => {
              mode = "insert";
              return builder;
            }),
            update: vi.fn((values: Record<string, unknown>) => {
              mode = "update";
              pendingUpdate = values;
              return builder;
            }),
            eq: vi.fn((col: string, val: unknown) => {
              eqArgs.push([col, val]);
              return builder;
            }),
            single: vi.fn(async () => ({ data: { id: "approval-1" }, error: null })),
            then: (resolve: (v: unknown) => unknown) => {
              if (mode === "update") {
                approvalsUpdateCalls.push({ values: pendingUpdate ?? {}, eqArgs });
                return Promise.resolve({ data: null, error: null }).then(resolve);
              }
              return Promise.resolve({ data: { id: "approval-1" }, error: null }).then(resolve);
            },
          };
          return builder;
        }
        return makeQuery({ data: null, error: null });
      }),
    });

    return { fake, approvalsUpdateCalls };
  }

  beforeEach(() => {
    captureServerEventMock.mockClear();
    serviceClientMock.mockReset();
  });

  it("emits sequence_activated AND persists status=approved when count of prior approved batches is 0", async () => {
    const { fake, approvalsUpdateCalls } = wireClient({ countResult: { count: 0, error: null } });
    const { step, calls, sentEvents } = makeStep({ data: { decision: "approve", notes: null } });

    await runSendBatchGenerate({
      event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
      step: step as any,
    });

    // Funnel side: emission with full payload + $insert_id keyed on
    // first_batch_id. Iter 24 stamped this so a retried emit-step (transient
    // PostHog 5xx) collapses on PostHog's 24h dedup window instead of double-
    // counting the "first batch approved" conversion.
    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventMock).toHaveBeenCalledWith("cust-1", "sequence_activated", {
      campaign_id: "camp-1",
      sequence_id: "seq-1",
      first_batch_id: "batch-1",
      batch_date: "2026-05-14",
      $insert_id: "sequence_activated:batch-1",
    });

    // Count-query was actually issued with the expected filter shape
    expect(fake.countQueryCalls).toHaveLength(1);
    expect(fake.countQueryCalls[0]!.eqArgs).toEqual(
      expect.arrayContaining([["campaign_id", "camp-1"], ["status", "approved"]]),
    );
    expect(fake.countQueryCalls[0]!.neqArgs).toEqual([["id", "batch-1"]]);

    // Persistence: send_batches row marked approved, approvals_queue row updated
    expect(fake.updateCalls).toHaveLength(1);
    expect(fake.updateCalls[0]!.values).toMatchObject({ status: "approved" });
    expect(fake.updateCalls[0]!.eqArgs).toEqual([["id", "batch-1"]]);
    expect(approvalsUpdateCalls).toHaveLength(1);
    expect(approvalsUpdateCalls[0]!.values).toMatchObject({
      status: "approved",
      operator_action: "approve",
      operator_notes: null,
    });

    assertUniqueStepIds(calls, sentEvents);
  });

  it("DOES NOT emit sequence_activated when this is the 2nd+ approved batch", async () => {
    wireClient({ countResult: { count: 3, error: null } });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await runSendBatchGenerate({
      event: { data: { campaign_id: "camp-1", batch_date: "2026-05-15" } },
      step: step as any,
    });

    expect(captureServerEventMock).not.toHaveBeenCalled();
  });

  it("DOES NOT emit sequence_activated AND persists status=rejected when operator rejects", async () => {
    const { fake, approvalsUpdateCalls } = wireClient({ countResult: { count: 0, error: null } });
    const { step } = makeStep({ data: { decision: "reject", notes: "off-brand" } });

    await runSendBatchGenerate({
      event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
      step: step as any,
    });

    expect(captureServerEventMock).not.toHaveBeenCalled();
    expect(fake.updateCalls[0]!.values).toMatchObject({ status: "rejected" });
    expect(approvalsUpdateCalls[0]!.values).toMatchObject({
      status: "rejected",
      operator_action: "reject",
      operator_notes: "off-brand",
    });
  });

  it("THROWS (so Inngest retries the step) when count query errors — funnel emission is never silently dropped", async () => {
    wireClient({ countResult: { count: null, error: new Error("db down") } });
    const { step } = makeStep({ data: { decision: "approve", notes: null } });

    await expect(
      runSendBatchGenerate({
        event: { data: { campaign_id: "camp-1", batch_date: "2026-05-14" } },
        step: step as any,
      }),
    ).rejects.toThrow(/db down/);
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
    const paginated = makePaginatedCampaignsMock([campaigns]);
    serviceClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "campaigns") return paginated.next();
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

    const { step, calls, sentEvents } = makeStep();
    await runPerformanceDailyPull({ step: step as any });

    expect(captureServerEventMock).toHaveBeenCalledTimes(2);

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

    for (const call of captureServerEventMock.mock.calls) {
      const props = (call as unknown as [string, string, { snapshot_date: string; $insert_id: string }])[2];
      expect(props.snapshot_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Iter 24: `$insert_id` mirrors the performance_snapshots upsert's
      // natural unique key (`campaign_id:snapshot_date`). A retried emit-step
      // re-derives the identical key so PostHog collapses the duplicate.
      expect(props.$insert_id).toBe(
        `performance_report_sent:${(call as unknown as [string, string, { campaign_id: string }])[2].campaign_id}:${props.snapshot_date}`,
      );
    }

    const emitIds = calls.filter((c) => c.id.startsWith("emit-perf-report-funnel-")).map((c) => c.id);
    expect(emitIds).toEqual(["emit-perf-report-funnel-camp-A", "emit-perf-report-funnel-camp-B"]);
    assertUniqueStepIds(calls, sentEvents);
  });

  it("skips campaigns missing smartlead_campaign_id and emits no event for them", async () => {
    const campaigns = [
      { id: "camp-A", customer_id: "cust-A", smartlead_campaign_id: null, started_at: "2026-04-01T00:00:00Z" },
      { id: "camp-B", customer_id: "cust-B", smartlead_campaign_id: "200", started_at: "2026-04-15T00:00:00Z" },
    ];
    const paginated = makePaginatedCampaignsMock([campaigns]);
    serviceClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "campaigns") return paginated.next();
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

    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "cust-B",
      "performance_report_sent",
      expect.objectContaining({ campaign_id: "camp-B" }),
    );
  });

  it("sends rewrite/requested event when trigger_free_rewrite is true (21-day uplift miss)", async () => {
    const campaigns = [
      { id: "camp-A", customer_id: "cust-A", smartlead_campaign_id: "100", started_at: "2026-04-01T00:00:00Z" },
      { id: "camp-B", customer_id: "cust-B", smartlead_campaign_id: "200", started_at: "2026-04-15T00:00:00Z" },
    ];
    const paginated = makePaginatedCampaignsMock([campaigns]);
    serviceClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "campaigns") return paginated.next();
        return makeQuery({ data: null, error: null });
      }),
    });
    getCampaignMetricsMock.mockResolvedValue({ sent: 100, unique_opens: 30, replies: 1 });
    // camp-A misses the uplift target → free-rewrite triggered.
    // camp-B is healthy → no free-rewrite.
    computePerformanceMock.mockImplementation(({ campaign_id, customer_id }) => ({
      campaign_id,
      customer_id,
      current_reply_rate: 0.01,
      uplift_pct: -5,
      trigger_free_rewrite: campaign_id === "camp-A",
    }));

    const { step, sentEvents, calls } = makeStep();
    const out = await runPerformanceDailyPull({ step: step as any });

    // Exactly one free-rewrite event, scoped to camp-A's customer
    const freeRewriteEvents = sentEvents.filter((e) => e.payload.name === "rewrite/requested");
    expect(freeRewriteEvents).toHaveLength(1);
    expect(freeRewriteEvents[0]!.id).toBe("free-rewrite-camp-A");
    expect(freeRewriteEvents[0]!.payload).toEqual({
      name: "rewrite/requested",
      data: { customer_id: "cust-A", sequence_id: "" },
    });

    // Return shape reports both campaigns with trigger flags
    expect(out.results).toEqual([
      expect.objectContaining({ campaign_id: "camp-A", trigger_free_rewrite: true }),
      expect.objectContaining({ campaign_id: "camp-B", trigger_free_rewrite: false }),
    ]);

    assertUniqueStepIds(calls, sentEvents);
  });

  it("paginates list-active-campaigns and fetches all pages until short page returned", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      id: `camp-${i}`,
      customer_id: `cust-${i}`,
      smartlead_campaign_id: null, // null → skip metric pull, keeps test fast
      started_at: "2026-04-01T00:00:00Z",
    }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({
      id: `camp-${200 + i}`,
      customer_id: `cust-${200 + i}`,
      smartlead_campaign_id: null,
      started_at: "2026-04-01T00:00:00Z",
    }));
    const paginated = makePaginatedCampaignsMock([page1, page2]);
    serviceClientMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "campaigns") return paginated.next();
        return makeQuery({ data: null, error: null });
      }),
    });

    const { step } = makeStep();
    const out = await runPerformanceDailyPull({ step: step as any });

    expect(paginated.rangeCalls).toEqual([[0, 199], [200, 399]]);
    // No emissions (all campaigns lack smartlead_campaign_id and are skipped).
    expect(out.processed).toBe(0);
  });
});
