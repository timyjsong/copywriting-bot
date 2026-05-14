import { beforeEach, describe, expect, it, vi } from "vitest";

const { runSupportAgentMock } = vi.hoisted(() => ({
  runSupportAgentMock: vi.fn(),
}));

vi.mock("@copywriting-bot/agents", () => ({
  support: { runSupportAgent: runSupportAgentMock },
}));

// NOTE: no `vi.mock("@copywriting-bot/db/client")` — the pipeline functions
// take `db` via their ctx so tests inject the fake directly (DI seam from
// iter 10).

// File-level reset so `runSupportAgentMock` cannot leak across describe
// blocks. Iter 13 finding: hoisted mocks shared across describes are
// exactly the foot-gun that bit iter 9. Resetting in every block's
// beforeEach instead of file-level made cross-describe-block isolation
// depend on test ordering.
beforeEach(() => {
  runSupportAgentMock.mockReset();
});

import { runRefundRequested } from "./refund.js";
import { runSupportReplyPipeline } from "./support.js";
import {
  assertUniqueStepIds,
  makeStep,
  makeSupabaseFake,
  type TableConfig,
} from "../test-utils/supabase-fake.js";

// ----------------------------------------------------------------- refund

describe("runRefundRequested — approval gate + DB error surfacing", () => {
  const baseEvent = {
    data: {
      customer_id: "cust-1",
      stripe_charge_id: "ch_123",
      amount: 297,
      currency: "usd",
      reason: "Customer requested refund",
    },
  };

  function wire(tables: Record<string, TableConfig>) {
    return makeSupabaseFake(tables);
  }

  it("returns {status:'timeout'} and does not write decision when operator never responds", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-1" }, error: null },
      },
    });
    const { step, calls, sentEvents } = makeStep(null); // null = timeout

    const out = await runRefundRequested({
      event: baseEvent,
      step: step as never,
      db: fake.db,
    });

    expect(out).toEqual({ status: "timeout", approvalId: "appr-1" });
    // apply-decision must NOT have run on timeout — only create-approval did.
    const stepIds = calls.map((c) => c.id);
    expect(stepIds).toEqual(["create-approval"]);
    expect(fake.recorded.update.approvals_queue).toEqual([]);
    // `customers` wasn't configured because no apply-decision should fire.
    // Treat absent table key as zero writes.
    expect(fake.recorded.update.customers ?? []).toEqual([]);
    assertUniqueStepIds(calls, sentEvents);
  });

  it("THROWS when create-approval insert errors (so Inngest retries)", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: null, error: { message: "db down" } },
      },
    });
    const { step } = makeStep(null);

    await expect(
      runRefundRequested({ event: baseEvent, step: step as never, db: fake.db }),
    ).rejects.toMatchObject({ message: "db down" });
  });

  it("on approve: updates approval AND marks customer churned (both writes recorded)", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-2" }, error: null },
        update: { error: null },
      },
      customers: {
        update: { error: null },
      },
    });
    const { step, calls, sentEvents } = makeStep({
      data: { decision: "approve", notes: "ok refund" },
    });

    const out = await runRefundRequested({
      event: baseEvent,
      step: step as never,
      db: fake.db,
    });

    expect(out).toEqual({ status: "approve", approvalId: "appr-2" });

    const approvalsUpdates = fake.recorded.update.approvals_queue!;
    expect(approvalsUpdates).toHaveLength(1);
    expect(approvalsUpdates[0]!.values).toMatchObject({
      status: "approved",
      operator_action: "approve",
      operator_notes: "ok refund",
    });
    expect(approvalsUpdates[0]!.values.decided_at).toEqual(expect.any(String));

    const customerUpdates = fake.recorded.update.customers!;
    expect(customerUpdates).toHaveLength(1);
    expect(customerUpdates[0]!.values).toEqual({ status: "churned" });
    expect(customerUpdates[0]!.eqArgs).toEqual([["id", "cust-1"]]);

    assertUniqueStepIds(calls, sentEvents);
  });

  it("on reject: updates approval as rejected but does NOT touch customers", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-3" }, error: null },
        update: { error: null },
      },
      customers: { update: { error: null } },
    });
    const { step } = makeStep({
      data: { decision: "reject", notes: "not eligible" },
    });

    const out = await runRefundRequested({
      event: baseEvent,
      step: step as never,
      db: fake.db,
    });

    expect(out).toEqual({ status: "reject", approvalId: "appr-3" });
    expect(fake.recorded.update.approvals_queue![0]!.values.status).toBe("rejected");
    expect(fake.recorded.update.customers ?? []).toEqual([]);
  });

  it("THROWS when apply-decision approvals_queue.update errors (silent-DB-failure guard)", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-4" }, error: null },
        update: { error: { message: "approvals update failed" } },
      },
      customers: { update: { error: null } },
    });
    const { step } = makeStep({ data: { decision: "approve" } });

    await expect(
      runRefundRequested({ event: baseEvent, step: step as never, db: fake.db }),
    ).rejects.toMatchObject({ message: "approvals update failed" });
  });

  it("THROWS when apply-decision customers.update errors on approved refund", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-5" }, error: null },
        update: { error: null },
      },
      customers: {
        update: { error: { message: "customers update failed" } },
      },
    });
    const { step } = makeStep({ data: { decision: "approve" } });

    await expect(
      runRefundRequested({ event: baseEvent, step: step as never, db: fake.db }),
    ).rejects.toMatchObject({ message: "customers update failed" });
  });

  it("treats null notes as null (not the string 'null') on apply-decision", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-6" }, error: null },
        update: { error: null },
      },
      customers: { update: { error: null } },
    });
    const { step } = makeStep({ data: { decision: "reject" } }); // notes omitted

    await runRefundRequested({ event: baseEvent, step: step as never, db: fake.db });

    expect(fake.recorded.update.approvals_queue![0]!.values.operator_notes).toBeNull();
  });

  it("waitForEvent payload pins the 5-day timeout + filter expression to approvalId", async () => {
    const fake = wire({
      approvals_queue: { insert: { data: { id: "appr-7" }, error: null } },
    });
    const { step } = makeStep(null);

    await runRefundRequested({ event: baseEvent, step: step as never, db: fake.db });

    expect(step.waitForEvent).toHaveBeenCalledWith(
      "await-operator-approval",
      {
        event: "operator.approval",
        timeout: "5d",
        if: `async.data.id == "appr-7"`,
      },
    );
  });

  // Iter 13 gap-coverage: pin the approvals_queue insert PAYLOAD for refund
  // (the support describe has the symmetric assertion; refund didn't, so a
  // regression that swapped fields or dropped payload_json would slip past).
  it("approval-queue insert carries refund payload (type, entity_id, customer_id, payload_json{amount,currency,reason})", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-payload" }, error: null },
        update: { error: null },
      },
      customers: { update: { error: null } },
    });
    const { step } = makeStep({ data: { decision: "approve" } });

    await runRefundRequested({
      event: {
        data: {
          customer_id: "cust-payload",
          stripe_charge_id: "ch_payload",
          amount: 297,
          currency: "usd",
          reason: "early-termination",
        },
      },
      step: step as never,
      db: fake.db,
    });

    const inserts = fake.recorded.insert.approvals_queue!;
    expect(inserts).toHaveLength(1);
    const inserted = inserts[0]!.values;
    expect(inserted.type).toBe("refund");
    expect(inserted.entity_id).toBe("ch_payload");
    expect(inserted.customer_id).toBe("cust-payload");
    expect(inserted.status).toBe("pending");
    expect(inserted.payload_json).toEqual({
      amount: 297,
      currency: "usd",
      reason: "early-termination",
    });
  });

  // Iter 13 gap-coverage: explicit decided_at format pin. Asserting
  // `expect.any(String)` accepts `Date.now()`-coerced numerics; this pins
  // the actual ISO-8601 shape so a regression would surface.
  it("decided_at is a parseable ISO-8601 string (not Date.now() coerced)", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-iso" }, error: null },
        update: { error: null },
      },
      customers: { update: { error: null } },
    });
    const { step } = makeStep({ data: { decision: "approve" } });

    await runRefundRequested({
      event: {
        ...baseEvent,
        data: { ...baseEvent.data, customer_id: "cust-iso" },
      },
      step: step as never,
      db: fake.db,
    });

    const decidedAt = fake.recorded.update.approvals_queue![0]!.values.decided_at;
    expect(typeof decidedAt).toBe("string");
    expect(decidedAt as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isFinite(new Date(decidedAt as string).getTime())).toBe(true);
  });

  // Iter 13 gap-coverage: non-"reject" decisions (e.g. "edit") fall into
  // the approved branch and mark the customer churned. Without this test,
  // a regression that tightened the predicate to strict-equal-"approve"
  // would silently break operator UIs that emit richer action strings.
  it("non-'reject' decision values (e.g. 'edit') route into the approved branch", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-edit" }, error: null },
        update: { error: null },
      },
      customers: { update: { error: null } },
    });
    const { step } = makeStep({ data: { decision: "edit", notes: "partial refund" } });

    const out = await runRefundRequested({
      event: { ...baseEvent, data: { ...baseEvent.data, customer_id: "cust-edit" } },
      step: step as never,
      db: fake.db,
    });

    expect(out).toEqual({ status: "edit", approvalId: "appr-edit" });
    expect(fake.recorded.update.approvals_queue![0]!.values).toMatchObject({
      status: "approved",
      operator_action: "edit",
      operator_notes: "partial refund",
    });
    expect(fake.recorded.update.customers).toHaveLength(1);
    expect(fake.recorded.update.customers![0]!.values).toEqual({ status: "churned" });
  });

  // Iter 13 gap-coverage: idempotency of apply-decision under Inngest's
  // step-level retry. If the step is re-executed after the approvals_queue
  // update already landed (e.g. transient network blip after the write but
  // before the step return), the second run must converge to the same
  // terminal state without double-mutating the customer or throwing.
  it("apply-decision is idempotent on retry (approve twice yields same terminal state)", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-retry" }, error: null },
        update: { error: null },
      },
      customers: { update: { error: null } },
    });
    const { step } = makeStep({ data: { decision: "approve" } });

    // First run.
    await runRefundRequested({
      event: { ...baseEvent, data: { ...baseEvent.data, customer_id: "cust-retry" } },
      step: step as never,
      db: fake.db,
    });
    const updatesAfterFirst = fake.recorded.update.approvals_queue!.length;
    const custUpdatesAfterFirst = fake.recorded.update.customers!.length;

    // Second run (simulating Inngest retry re-running the whole function).
    await runRefundRequested({
      event: { ...baseEvent, data: { ...baseEvent.data, customer_id: "cust-retry" } },
      step: step as never,
      db: fake.db,
    });

    // Both runs converge: each approvals_queue.update + customers.update
    // ran twice in total (once per invocation) and the terminal values
    // match. No throw, no divergence.
    expect(fake.recorded.update.approvals_queue!.length).toBe(updatesAfterFirst * 2);
    expect(fake.recorded.update.customers!.length).toBe(custUpdatesAfterFirst * 2);
    for (const w of fake.recorded.update.approvals_queue!) {
      expect(w.values).toMatchObject({ status: "approved", operator_action: "approve" });
    }
    for (const w of fake.recorded.update.customers!) {
      expect(w.values).toEqual({ status: "churned" });
    }
  });
});

// ---------------------------------------------------------------- support

describe("runSupportReplyPipeline — triage + approval gate + DB error surfacing", () => {
  const baseEvent = {
    data: {
      customer_email: "user@example.com",
      subject: "Help",
      body: "I have a question",
      recent_thread: "",
      twenty_one_day_metric_missed: false,
    },
  };

  function wire(tables: Record<string, TableConfig>) {
    return makeSupabaseFake(tables);
  }

  beforeEach(() => {
    runSupportAgentMock.mockReset();
  });

  it("returns {status:'spam_filtered'} and never queues approval when triage.category === 'spam'", async () => {
    runSupportAgentMock.mockResolvedValueOnce({
      ok: true,
      triage: {
        category: "spam",
        urgency: "low",
        operator_notes: "n/a",
        auto_offer_refund: false,
      },
    });
    const fake = wire({ approvals_queue: {} });
    const { step, calls, sentEvents } = makeStep(null);

    const out = await runSupportReplyPipeline({
      event: baseEvent,
      step: step as never,
      db: fake.db,
    });

    expect(out).toEqual({ status: "spam_filtered" });
    expect(fake.recorded.insert.approvals_queue).toEqual([]);
    // Only the triage step ran. Approval/wait/decision never fired.
    expect(calls.map((c) => c.id)).toEqual(["triage"]);
    assertUniqueStepIds(calls, sentEvents);
  });

  it("THROWS when triage returns {ok:false} (so Inngest retries upstream)", async () => {
    runSupportAgentMock.mockResolvedValueOnce({ ok: false, error: "anthropic 5xx" });
    const fake = wire({ approvals_queue: {} });
    const { step } = makeStep(null);

    await expect(
      runSupportReplyPipeline({ event: baseEvent, step: step as never, db: fake.db }),
    ).rejects.toMatchObject({ message: "anthropic 5xx" });
  });

  it("returns {status:'timeout'} and does not write decision when operator never responds", async () => {
    runSupportAgentMock.mockResolvedValueOnce({
      ok: true,
      triage: {
        category: "product_question",
        urgency: "medium",
        draft_reply: "Hi…",
        operator_notes: "answer Q",
        auto_offer_refund: false,
      },
    });
    const fake = wire({
      approvals_queue: { insert: { data: { id: "appr-s1" }, error: null } },
    });
    const { step, calls, sentEvents } = makeStep(null);

    const out = await runSupportReplyPipeline({
      event: baseEvent,
      step: step as never,
      db: fake.db,
    });

    expect(out).toEqual({ status: "timeout", approvalId: "appr-s1" });
    expect(fake.recorded.update.approvals_queue).toEqual([]);
    expect(calls.map((c) => c.id)).toEqual(["triage", "create-approval"]);
    assertUniqueStepIds(calls, sentEvents);
  });

  it("on approve: persists 'approved' status + returns category in result", async () => {
    runSupportAgentMock.mockResolvedValueOnce({
      ok: true,
      triage: {
        category: "refund_request",
        urgency: "high",
        draft_reply: "Sorry to see you go…",
        operator_notes: "refund eligible",
        auto_offer_refund: true,
      },
    });
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-s2" }, error: null },
        update: { error: null },
      },
    });
    const { step } = makeStep({ data: { decision: "approve", notes: "send it" } });

    const out = await runSupportReplyPipeline({
      event: baseEvent,
      step: step as never,
      db: fake.db,
    });

    expect(out).toEqual({
      status: "approve",
      approvalId: "appr-s2",
      category: "refund_request",
    });
    expect(fake.recorded.update.approvals_queue![0]!.values).toMatchObject({
      status: "approved",
      operator_action: "approve",
      operator_notes: "send it",
    });
  });

  it("on reject: persists 'rejected' status", async () => {
    runSupportAgentMock.mockResolvedValueOnce({
      ok: true,
      triage: {
        category: "complaint",
        urgency: "medium",
        operator_notes: "decline",
        auto_offer_refund: false,
      },
    });
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-s3" }, error: null },
        update: { error: null },
      },
    });
    const { step } = makeStep({ data: { decision: "reject" } });

    const out = await runSupportReplyPipeline({
      event: baseEvent,
      step: step as never,
      db: fake.db,
    });

    expect(out).toMatchObject({ status: "reject", category: "complaint" });
    expect(fake.recorded.update.approvals_queue![0]!.values.status).toBe("rejected");
  });

  it("THROWS when create-approval insert errors (Inngest retries)", async () => {
    runSupportAgentMock.mockResolvedValueOnce({
      ok: true,
      triage: {
        category: "product_question",
        urgency: "low",
        operator_notes: "ans",
        auto_offer_refund: false,
      },
    });
    const fake = wire({
      approvals_queue: { insert: { data: null, error: { message: "queue insert failed" } } },
    });
    const { step } = makeStep(null);

    await expect(
      runSupportReplyPipeline({ event: baseEvent, step: step as never, db: fake.db }),
    ).rejects.toMatchObject({ message: "queue insert failed" });
  });

  it("THROWS when apply-decision update errors (silent-DB-failure guard)", async () => {
    runSupportAgentMock.mockResolvedValueOnce({
      ok: true,
      triage: {
        category: "objection",
        urgency: "medium",
        operator_notes: "handle",
        auto_offer_refund: false,
      },
    });
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-s4" }, error: null },
        update: { error: { message: "decision update failed" } },
      },
    });
    const { step } = makeStep({ data: { decision: "approve" } });

    await expect(
      runSupportReplyPipeline({ event: baseEvent, step: step as never, db: fake.db }),
    ).rejects.toMatchObject({ message: "decision update failed" });
  });

  it("approval-queue insert carries triage payload + inbound subject/body/thread", async () => {
    const triage = {
      category: "billing_question" as const,
      urgency: "low" as const,
      draft_reply: "Sure",
      operator_notes: "bill q",
      auto_offer_refund: false,
    };
    runSupportAgentMock.mockResolvedValueOnce({ ok: true, triage });

    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-s5" }, error: null },
        update: { error: null },
      },
    });
    const { step } = makeStep({ data: { decision: "approve" } });

    await runSupportReplyPipeline({
      event: {
        data: {
          customer_email: "billing@acme.test",
          subject: "Invoice?",
          body: "Where is it?",
          recent_thread: "prev thread snippet",
          twenty_one_day_metric_missed: false,
        },
      },
      step: step as never,
      db: fake.db,
    });

    const inserts = fake.recorded.insert.approvals_queue!;
    expect(inserts).toHaveLength(1);
    const inserted = inserts[0]!.values;
    expect(inserted.type).toBe("support_reply");
    expect(inserted.entity_id).toBe("billing@acme.test");
    expect(inserted.status).toBe("pending");
    expect(inserted.payload_json).toEqual({
      triage,
      inbound: {
        subject: "Invoice?",
        body: "Where is it?",
        recent_thread: "prev thread snippet",
      },
    });
  });

  it("waitForEvent payload pins the 3-day timeout + filter expression to approvalId", async () => {
    runSupportAgentMock.mockResolvedValueOnce({
      ok: true,
      triage: {
        category: "product_question",
        urgency: "low",
        operator_notes: "ans",
        auto_offer_refund: false,
      },
    });
    const fake = wire({
      approvals_queue: { insert: { data: { id: "appr-s6" }, error: null } },
    });
    const { step } = makeStep(null);

    await runSupportReplyPipeline({ event: baseEvent, step: step as never, db: fake.db });

    expect(step.waitForEvent).toHaveBeenCalledWith(
      "await-operator-approval",
      {
        event: "operator.approval",
        timeout: "3d",
        if: `async.data.id == "appr-s6"`,
      },
    );
  });

  // Iter 13 gap-coverage: pin runSupportAgent call args. Without this, a
  // regression that mis-defaults `recent_thread` or
  // `twenty_one_day_metric_missed` would slip past — every prior test
  // supplied both fields explicitly so the `?? ""` / `?? false` fallbacks
  // were never exercised.
  it("calls runSupportAgent with all 5 event fields when present", async () => {
    runSupportAgentMock.mockResolvedValueOnce({
      ok: true,
      triage: {
        category: "product_question",
        urgency: "low",
        operator_notes: "ans",
        auto_offer_refund: false,
      },
    });
    const fake = wire({
      approvals_queue: { insert: { data: { id: "appr-args1" }, error: null } },
    });
    const { step } = makeStep(null);

    await runSupportReplyPipeline({
      event: {
        data: {
          customer_email: "alice@example.com",
          subject: "Hi",
          body: "Question",
          recent_thread: "prev: …",
          twenty_one_day_metric_missed: true,
        },
      },
      step: step as never,
      db: fake.db,
    });

    expect(runSupportAgentMock).toHaveBeenCalledTimes(1);
    expect(runSupportAgentMock).toHaveBeenCalledWith({
      customer_email: "alice@example.com",
      subject: "Hi",
      body: "Question",
      recent_thread: "prev: …",
      twenty_one_day_metric_missed: true,
    });
  });

  // Iter 13 gap-coverage: exercise the new defaulting behaviour added in
  // support.ts:38-44. When the event omits `recent_thread` /
  // `twenty_one_day_metric_missed`, the pipeline must pass `""` / `false`
  // to the agent (not `undefined`).
  it("defaults recent_thread to '' and twenty_one_day_metric_missed to false when omitted", async () => {
    runSupportAgentMock.mockResolvedValueOnce({
      ok: true,
      triage: {
        category: "product_question",
        urgency: "low",
        operator_notes: "ans",
        auto_offer_refund: false,
      },
    });
    const fake = wire({
      approvals_queue: { insert: { data: { id: "appr-args2" }, error: null } },
    });
    const { step } = makeStep(null);

    await runSupportReplyPipeline({
      event: {
        data: {
          customer_email: "bob@example.com",
          subject: "?",
          body: "no thread here",
          // recent_thread + twenty_one_day_metric_missed intentionally omitted
        },
      },
      step: step as never,
      db: fake.db,
    });

    expect(runSupportAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_email: "bob@example.com",
        recent_thread: "",
        twenty_one_day_metric_missed: false,
      }),
    );
  });

  // Iter 13 gap-coverage: explicit decided_at ISO-8601 pin (symmetric to
  // the refund test added in this iter).
  it("decided_at is a parseable ISO-8601 string", async () => {
    runSupportAgentMock.mockResolvedValueOnce({
      ok: true,
      triage: {
        category: "product_question",
        urgency: "low",
        operator_notes: "ans",
        auto_offer_refund: false,
      },
    });
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-iso-s" }, error: null },
        update: { error: null },
      },
    });
    const { step } = makeStep({ data: { decision: "approve" } });

    await runSupportReplyPipeline({ event: baseEvent, step: step as never, db: fake.db });

    const decidedAt = fake.recorded.update.approvals_queue![0]!.values.decided_at;
    expect(typeof decidedAt).toBe("string");
    expect(decidedAt as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  // Iter 13 gap-coverage: non-"reject" decisions (e.g. "edit") fall into
  // the approved branch on support too. Pins the support.ts ternary so a
  // regression tightening to strict-equal-"approve" would surface.
  it("non-'reject' decision values (e.g. 'edit') route into the approved branch", async () => {
    runSupportAgentMock.mockResolvedValueOnce({
      ok: true,
      triage: {
        category: "product_question",
        urgency: "low",
        operator_notes: "ans",
        auto_offer_refund: false,
      },
    });
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-s-edit" }, error: null },
        update: { error: null },
      },
    });
    const { step } = makeStep({ data: { decision: "edit", notes: "tweak it" } });

    const out = await runSupportReplyPipeline({
      event: baseEvent,
      step: step as never,
      db: fake.db,
    });

    expect(out).toEqual({
      status: "edit",
      approvalId: "appr-s-edit",
      category: "product_question",
    });
    expect(fake.recorded.update.approvals_queue![0]!.values).toMatchObject({
      status: "approved",
      operator_action: "edit",
      operator_notes: "tweak it",
    });
  });
});

// ----------------------------------------- supabase-fake .single() recording
//
// Iter 13 fix to supabase-fake.ts:144-154 made `.single()` record the
// insert (the `.insert(v).select().single()` chain previously skipped the
// `.then` branch and silently dropped the recorded write). The support
// payload-shape test exercised this transitively, but a targeted unit
// test on the fake itself prevents regression of the fix in isolation.

describe("supabase-fake — insert recording via .single() terminator", () => {
  it("records the insert payload exactly once when the chain ends with .single()", async () => {
    const fake = makeSupabaseFake({
      approvals_queue: {
        insert: { data: { id: "x" }, error: null },
      },
    });

    const { data, error } = await fake.db
      .from("approvals_queue")
      .insert({ type: "refund", entity_id: "ch_x", status: "pending" })
      .select("id")
      .single();

    expect(error).toBeNull();
    expect((data as { id: string }).id).toBe("x");
    expect(fake.recorded.insert.approvals_queue).toHaveLength(1);
    expect(fake.recorded.insert.approvals_queue![0]!.values).toEqual({
      type: "refund",
      entity_id: "ch_x",
      status: "pending",
    });
  });

  it("records exactly once even when both .then and .single() are reachable on the same builder", async () => {
    // Idempotency-guard regression: without the `recorded_once` flag both
    // terminators would push to `recorded.insert`, falsely doubling the
    // count. This pins the guard.
    const fake = makeSupabaseFake({
      approvals_queue: { insert: { data: { id: "y" }, error: null } },
    });

    await fake.db
      .from("approvals_queue")
      .insert({ type: "support_reply", entity_id: "z", status: "pending" })
      .select("id")
      .single();

    expect(fake.recorded.insert.approvals_queue).toHaveLength(1);
  });
});
