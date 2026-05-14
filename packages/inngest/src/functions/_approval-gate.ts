import type { DbPort } from "./_db.js";
import type { FunnelStep } from "./_funnel.js";

/**
 * Operator-approval gate primitive (PRD §5.2).
 *
 * Iter 12+13 patched the silent-DB-error footgun in 4 separate pipelines
 * (onboarding, sendBatch, refund, support). This helper folds the shared
 * `insert approvals_queue → waitForEvent → update approvals_queue` shape
 * into one place so retry, error-rethrow, and step-ID discipline are
 * enforced uniformly.
 */

/**
 * Inngest `step` surface required by `withOperatorApproval`. Extends
 * `FunnelStep` so a pipeline that also emits funnel events can pass a
 * single narrowed `step` to both jobs without re-declaring the run shape.
 */
export type ApprovalStep = FunnelStep & {
  waitForEvent: (
    id: string,
    opts: { event: string; timeout: string; if: string },
  ) => Promise<{ data: { decision: string; notes?: string | null } } | null>;
};

export type OperatorDecision = { decision: string; notes?: string | null };

export type ApprovalType = "rewrite" | "send_batch" | "refund" | "support_reply";

export type WithOperatorApprovalArgs = {
  step: ApprovalStep;
  db: DbPort;
  type: ApprovalType;
  entityId: string;
  customerId?: string;
  payloadJson: object;
  /** Inngest timeout string, e.g. `"3d"`. PRD §5.2 mandates an explicit cap. */
  timeout: string;
  /**
   * Domain-specific side-effect that runs INSIDE the `apply-decision`
   * Inngest step (transactional with the approvals_queue update). Throws
   * propagate so Inngest retries the step (≤3 attempts, exponential
   * backoff). Any unrecognised decision string is treated as approved
   * (`approved = decision !== "reject"`); pinned by tests.
   */
  onDecision?: (ctx: { decision: OperatorDecision; approved: boolean }) => Promise<void>;
};

/**
 * Discriminated on `kind` so callers narrow with `outcome.kind === "timeout"`.
 * Discriminating on `status` would not narrow because the decided branch's
 * `status` is widened to `string` (the raw operator action) and includes the
 * literal `"timeout"`.
 */
export type ApprovalOutcome =
  | { kind: "timeout"; approvalId: string }
  | {
      kind: "decided";
      status: string;
      approvalId: string;
      approved: boolean;
      decision: OperatorDecision;
    };

/**
 * Insert an `approvals_queue` row, wait for `operator.approval` keyed by
 * that row id, then persist the operator's decision.
 *
 * Side-effect contract:
 *   - On timeout, returns `{ status: "timeout" }` and writes NOTHING to
 *     `approvals_queue.update` — callers may run their own timeout step
 *     (e.g. `mark-batch-failed`) after this returns.
 *   - On any non-`"reject"` decision string, treats the request as approved
 *     and runs `onDecision({ approved: true })`. Operator UIs may emit
 *     `"approve"`, `"edit"`, etc. — all routed to the approved branch.
 *   - All DB errors are re-thrown so Inngest retries the step. Silent
 *     failure would leave the queue stuck in `pending` while the pipeline
 *     reports success.
 *
 * Step IDs (per Inngest invocation, must be unique):
 *   - `create-approval`
 *   - `await-operator-approval`
 *   - `apply-decision`
 *
 * Callers must not reuse these IDs in the same function.
 */
export async function withOperatorApproval(
  args: WithOperatorApprovalArgs,
): Promise<ApprovalOutcome> {
  const { step, db, type, entityId, customerId, payloadJson, timeout, onDecision } = args;

  const approvalId = await step.run("create-approval", async () => {
    const row: Record<string, unknown> = {
      type,
      entity_id: entityId,
      payload_json: payloadJson,
      status: "pending",
    };
    if (customerId !== undefined) row.customer_id = customerId;

    const { data, error } = await db
      .from("approvals_queue")
      .insert(row)
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("Could not create approval");
    return (data as { id: string }).id;
  });

  const event = await step.waitForEvent("await-operator-approval", {
    event: "operator.approval",
    timeout,
    if: `async.data.id == "${approvalId}"`,
  });

  if (!event) {
    return { kind: "timeout", approvalId };
  }

  const decision: OperatorDecision = event.data;
  const approved = decision.decision !== "reject";

  await step.run("apply-decision", async () => {
    const { error: approvalErr } = await db
      .from("approvals_queue")
      .update({
        status: approved ? "approved" : "rejected",
        operator_action: decision.decision,
        operator_notes: decision.notes ?? null,
        decided_at: new Date().toISOString(),
      })
      .eq("id", approvalId);
    if (approvalErr) throw approvalErr;

    if (onDecision) await onDecision({ decision, approved });
  });

  return { kind: "decided", status: decision.decision, approvalId, approved, decision };
}
