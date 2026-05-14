import { describe, expect, it, vi } from "vitest";

import { withOperatorApproval } from "./_approval-gate.js";
import {
  assertUniqueStepIds,
  makeStep,
  makeSupabaseFake,
  type TableConfig,
} from "../test-utils/supabase-fake.js";

// Direct unit coverage for the shared approval-gate primitive. The
// per-pipeline tests in approval-gates.test.ts + funnel-events-edge.test.ts
// exercise it transitively; this file pins the helper's own contract so a
// future refactor that changes the gate semantics (e.g. swapping the
// approve/reject branch derivation) surfaces immediately rather than via a
// fan-out of seemingly-unrelated pipeline regressions.

function wire(tables: Record<string, TableConfig>) {
  return makeSupabaseFake(tables);
}

describe("withOperatorApproval — primitive contract", () => {
  it("inserts approvals_queue row with type + entity_id + customer_id + payload_json + status='pending'", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-1" }, error: null },
        update: { error: null },
      },
    });
    const { step } = makeStep({ data: { decision: "approve" } });

    await withOperatorApproval({
      step: step as never,
      db: fake.db,
      type: "refund",
      entityId: "ch_test",
      customerId: "cust-1",
      payloadJson: { amount: 100, currency: "usd" },
      timeout: "5d",
    });

    const inserts = fake.recorded.insert.approvals_queue!;
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values).toEqual({
      type: "refund",
      entity_id: "ch_test",
      customer_id: "cust-1",
      payload_json: { amount: 100, currency: "usd" },
      status: "pending",
    });
  });

  it("omits customer_id from insert payload when not supplied (support_reply has no customer FK)", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-2" }, error: null },
        update: { error: null },
      },
    });
    const { step } = makeStep({ data: { decision: "approve" } });

    await withOperatorApproval({
      step: step as never,
      db: fake.db,
      type: "support_reply",
      entityId: "user@example.com",
      payloadJson: { foo: "bar" },
      timeout: "3d",
    });

    const inserted = fake.recorded.insert.approvals_queue![0]!.values;
    expect("customer_id" in inserted).toBe(false);
  });

  it("returns {status:'timeout', approved:false, decision:null} and writes NO update on timeout", async () => {
    const fake = wire({
      approvals_queue: { insert: { data: { id: "appr-t" }, error: null } },
    });
    const { step, calls, sentEvents } = makeStep(null);
    const onDecision = vi.fn();

    const out = await withOperatorApproval({
      step: step as never,
      db: fake.db,
      type: "refund",
      entityId: "ch_x",
      customerId: "cust-x",
      payloadJson: {},
      timeout: "5d",
      onDecision,
    });

    expect(out).toEqual({ kind: "timeout", approvalId: "appr-t" });
    expect(fake.recorded.update.approvals_queue ?? []).toEqual([]);
    expect(onDecision).not.toHaveBeenCalled();
    // Locks step-ID set on the timeout branch — apply-decision must not fire.
    expect(calls.map((c) => c.id)).toEqual(["create-approval"]);
    assertUniqueStepIds(calls, sentEvents);
  });

  it("on approve: writes approvals_queue.status='approved' and calls onDecision({approved:true})", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-a" }, error: null },
        update: { error: null },
      },
    });
    const { step } = makeStep({ data: { decision: "approve", notes: "ok" } });
    const onDecision = vi.fn(async () => undefined);

    const out = await withOperatorApproval({
      step: step as never,
      db: fake.db,
      type: "rewrite",
      entityId: "seq-1",
      customerId: "cust-1",
      payloadJson: {},
      timeout: "7d",
      onDecision,
    });

    expect(out).toMatchObject({
      kind: "decided",
      status: "approve",
      approved: true,
      approvalId: "appr-a",
    });
    if (out.kind !== "decided") throw new Error("expected decided outcome");
    expect(out.decision).toEqual({ decision: "approve", notes: "ok" });
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith({
      decision: { decision: "approve", notes: "ok" },
      approved: true,
    });

    const updates = fake.recorded.update.approvals_queue!;
    expect(updates).toHaveLength(1);
    expect(updates[0]!.values).toMatchObject({
      status: "approved",
      operator_action: "approve",
      operator_notes: "ok",
    });
  });

  it("on reject: writes approvals_queue.status='rejected' and calls onDecision({approved:false})", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-r" }, error: null },
        update: { error: null },
      },
    });
    const { step } = makeStep({ data: { decision: "reject" } });
    const onDecision = vi.fn(async () => undefined);

    const out = await withOperatorApproval({
      step: step as never,
      db: fake.db,
      type: "refund",
      entityId: "ch_y",
      customerId: "cust-y",
      payloadJson: {},
      timeout: "5d",
      onDecision,
    });

    expect(out).toMatchObject({ kind: "decided", status: "reject", approved: false });
    // The decision object is passed through as-received from the event;
    // `notes` is absent on this synthetic event so it's undefined (not
    // null). The approvals_queue write normalises to null — see the
    // separate "normalises operator_notes to null when omitted" test.
    expect(onDecision).toHaveBeenCalledWith({
      decision: { decision: "reject" },
      approved: false,
    });
    expect(fake.recorded.update.approvals_queue![0]!.values.status).toBe("rejected");
  });

  it("LOCKS contract: any non-'reject' decision string (e.g. 'edit', 'approve-with-tweaks') is treated as approved", async () => {
    // Operator UIs may emit semantically-rich actions beyond approve/reject.
    // The gate's `decision !== 'reject'` rule routes them all into the
    // approved branch. Pinning this prevents a future refactor from
    // accidentally adding strict-enum matching that silently rejects them.
    for (const raw of ["edit", "approve-with-changes", "send", "yes", ""]) {
      const fake = wire({
        approvals_queue: {
          insert: { data: { id: `appr-${raw}` }, error: null },
          update: { error: null },
        },
      });
      const { step } = makeStep({ data: { decision: raw } });

      const out = await withOperatorApproval({
        step: step as never,
        db: fake.db,
        type: "support_reply",
        entityId: "x",
        payloadJson: {},
        timeout: "3d",
      });

      if (out.kind !== "decided") throw new Error("expected decided outcome");
      expect(out.approved).toBe(true);
      expect(out.status).toBe(raw);
      expect(fake.recorded.update.approvals_queue![0]!.values.status).toBe("approved");
    }
  });

  it("normalises operator_notes to null when omitted (not the string 'null', not undefined)", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-n" }, error: null },
        update: { error: null },
      },
    });
    const { step } = makeStep({ data: { decision: "approve" } }); // notes omitted

    await withOperatorApproval({
      step: step as never,
      db: fake.db,
      type: "refund",
      entityId: "x",
      payloadJson: {},
      timeout: "5d",
    });

    expect(fake.recorded.update.approvals_queue![0]!.values.operator_notes).toBeNull();
  });

  it("decided_at is a parseable ISO-8601 string (regression-pinned, not just expect.any(String))", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-iso" }, error: null },
        update: { error: null },
      },
    });
    const { step } = makeStep({ data: { decision: "approve" } });

    await withOperatorApproval({
      step: step as never,
      db: fake.db,
      type: "refund",
      entityId: "x",
      payloadJson: {},
      timeout: "5d",
    });

    const decidedAt = fake.recorded.update.approvals_queue![0]!.values.decided_at;
    expect(typeof decidedAt).toBe("string");
    expect(decidedAt as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Round-trip: parsing must not return NaN (which a stringified Date.now() would).
    expect(Number.isFinite(new Date(decidedAt as string).getTime())).toBe(true);
  });

  it("THROWS when approvals_queue insert errors (so Inngest retries create-approval)", async () => {
    const fake = wire({
      approvals_queue: { insert: { data: null, error: { message: "queue insert failed" } } },
    });
    const { step } = makeStep({ data: { decision: "approve" } });

    await expect(
      withOperatorApproval({
        step: step as never,
        db: fake.db,
        type: "refund",
        entityId: "x",
        payloadJson: {},
        timeout: "5d",
      }),
    ).rejects.toMatchObject({ message: "queue insert failed" });
  });

  it("THROWS 'Could not create approval' when insert returns null data with no error", async () => {
    const fake = wire({
      approvals_queue: { insert: { data: null, error: null } },
    });
    const { step } = makeStep({ data: { decision: "approve" } });

    await expect(
      withOperatorApproval({
        step: step as never,
        db: fake.db,
        type: "refund",
        entityId: "x",
        payloadJson: {},
        timeout: "5d",
      }),
    ).rejects.toThrow(/Could not create approval/);
  });

  it("THROWS when approvals_queue update errors in apply-decision (silent-DB-failure guard)", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-u" }, error: null },
        update: { error: new Error("approvals update failed") },
      },
    });
    const { step } = makeStep({ data: { decision: "approve" } });
    const onDecision = vi.fn();

    await expect(
      withOperatorApproval({
        step: step as never,
        db: fake.db,
        type: "refund",
        entityId: "x",
        payloadJson: {},
        timeout: "5d",
        onDecision,
      }),
    ).rejects.toThrow(/approvals update failed/);
    // approvals_queue update runs FIRST; onDecision must not have fired.
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("propagates onDecision throws (downstream domain write surfaces the same retry)", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-d" }, error: null },
        update: { error: null },
      },
    });
    const { step } = makeStep({ data: { decision: "approve" } });

    await expect(
      withOperatorApproval({
        step: step as never,
        db: fake.db,
        type: "refund",
        entityId: "x",
        payloadJson: {},
        timeout: "5d",
        onDecision: async () => {
          throw new Error("domain write failed");
        },
      }),
    ).rejects.toThrow(/domain write failed/);
  });

  it("waitForEvent payload pins timeout + filter expression to the inserted approvalId", async () => {
    const fake = wire({
      approvals_queue: { insert: { data: { id: "appr-wf" }, error: null } },
    });
    const { step } = makeStep(null);

    await withOperatorApproval({
      step: step as never,
      db: fake.db,
      type: "rewrite",
      entityId: "seq-x",
      customerId: "cust-x",
      payloadJson: {},
      timeout: "7d",
    });

    expect(step.waitForEvent).toHaveBeenCalledWith("await-operator-approval", {
      event: "operator.approval",
      timeout: "7d",
      if: `async.data.id == "appr-wf"`,
    });
  });

  it("emits step IDs create-approval, await-operator-approval, apply-decision — and only those — on the happy path", async () => {
    const fake = wire({
      approvals_queue: {
        insert: { data: { id: "appr-id" }, error: null },
        update: { error: null },
      },
    });
    const { step, calls, sentEvents } = makeStep({ data: { decision: "approve" } });

    await withOperatorApproval({
      step: step as never,
      db: fake.db,
      type: "refund",
      entityId: "x",
      payloadJson: {},
      timeout: "5d",
    });

    expect(calls.map((c) => c.id)).toEqual(["create-approval", "apply-decision"]);
    assertUniqueStepIds(calls, sentEvents);
  });
});
