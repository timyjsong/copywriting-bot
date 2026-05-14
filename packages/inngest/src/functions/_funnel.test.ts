import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureServerEventMock } = vi.hoisted(() => ({
  captureServerEventMock: vi.fn(
    async (_customerId: string, _event: string, _props: Record<string, unknown>) => undefined,
  ),
}));

vi.mock("@copywriting-bot/shared/observability", () => ({
  captureServerEvent: captureServerEventMock,
  // Real format — must match production `funnelInsertId` so the test contract
  // pins the actual key shape PostHog sees, not a fake the helper just echoes.
  funnelInsertId: (event: string, key: string) => `${event}:${key}`,
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

import { emitFunnelEvent, type FunnelStep } from "./_funnel.js";

/**
 * Direct unit tests for `emitFunnelEvent`. The integration suites verify
 * that pipelines fire the right events at the right moments; these tests
 * pin the helper's invariants (id pass-through, name pass-through, props
 * pass-through, await-ordering, and error propagation) at the boundary so
 * a regression localises here instead of in a slower integration suite.
 */
describe("emitFunnelEvent", () => {
  function makeRunningStep() {
    const calls: Array<{ id: string; fn: () => unknown }> = [];
    const runImpl = async <T>(id: string, fn: () => Promise<T> | T): Promise<T> => {
      calls.push({ id, fn });
      return await fn();
    };
    const step: FunnelStep & { run: ReturnType<typeof vi.fn> } = {
      run: vi.fn(runImpl) as unknown as FunnelStep["run"] & ReturnType<typeof vi.fn>,
    };
    return { step, calls };
  }

  beforeEach(() => {
    captureServerEventMock.mockReset();
    captureServerEventMock.mockResolvedValue(undefined);
  });

  it("passes the literal stepId to step.run", async () => {
    const { step, calls } = makeRunningStep();

    await emitFunnelEvent(step, "emit-foo-funnel-batch-42", "cust-A", "rewrite_approved", {});

    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("emit-foo-funnel-batch-42");
    expect(step.run).toHaveBeenCalledWith("emit-foo-funnel-batch-42", expect.any(Function));
  });

  it("passes customerId + eventName + props through to captureServerEvent unchanged", async () => {
    const { step } = makeRunningStep();
    const props = {
      sequence_id: "seq-7",
      approval_id: "appr-2",
      decision: "approve",
      nested: { foo: 1 },
    };

    await emitFunnelEvent(step, "emit-x", "cust-9", "rewrite_approved", props);

    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventMock).toHaveBeenCalledWith("cust-9", "rewrite_approved", props);
    // Reference-equality: helper should not clone or rewrap props.
    const firstCall = captureServerEventMock.mock.calls[0]!;
    expect(firstCall[2]).toBe(props);
  });

  it("awaits captureServerEvent before resolving (no fire-and-forget)", async () => {
    const { step } = makeRunningStep();
    let resolveCapture: () => void = () => undefined;
    captureServerEventMock.mockReturnValueOnce(
      new Promise<undefined>((res) => {
        resolveCapture = () => res(undefined);
      }),
    );

    let helperResolved = false;
    const helperPromise = emitFunnelEvent(step, "emit-x", "cust-1", "sequence_activated", {})
      .then(() => {
        helperResolved = true;
      });

    // Yield twice to let any microtasks settle. If `await` were missing,
    // `helperResolved` would already be true here.
    await Promise.resolve();
    await Promise.resolve();
    expect(helperResolved).toBe(false);

    resolveCapture();
    await helperPromise;
    expect(helperResolved).toBe(true);
  });

  it("propagates captureServerEvent rejections so Inngest retries the step", async () => {
    const { step } = makeRunningStep();
    captureServerEventMock.mockRejectedValueOnce(new Error("posthog down"));

    await expect(
      emitFunnelEvent(step, "emit-x", "cust-A", "performance_report_sent", { campaign_id: "c1" }),
    ).rejects.toThrow(/posthog down/);
  });

  it("invokes step.run exactly once per emit (no double-fire on retry-safe path)", async () => {
    const { step, calls } = makeRunningStep();

    await emitFunnelEvent(step, "emit-x", "cust-A", "rewrite_approved", { v: 1 });
    await emitFunnelEvent(step, "emit-y", "cust-A", "rewrite_approved", { v: 2 });

    expect(step.run).toHaveBeenCalledTimes(2);
    expect(calls.map((c) => c.id)).toEqual(["emit-x", "emit-y"]);
    expect(captureServerEventMock).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------- dedupKey ----
  //
  // When `dedupKey` is provided, the helper stamps `$insert_id` onto the props
  // so a retried `step.run` (transient PostHog 5xx) collapses on PostHog's 24h
  // dedup window instead of double-counting the conversion. These tests pin
  // the format + the no-key fallback so a future refactor cannot silently
  // break the dedup contract that iter 21/23 established.

  it("stamps $insert_id keyed on dedupKey when provided", async () => {
    const { step } = makeRunningStep();

    await emitFunnelEvent(
      step,
      "emit-x",
      "cust-A",
      "rewrite_approved",
      { sequence_id: "seq-1", approval_id: "appr-7" },
      "appr-7",
    );

    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventMock).toHaveBeenCalledWith("cust-A", "rewrite_approved", {
      sequence_id: "seq-1",
      approval_id: "appr-7",
      $insert_id: "rewrite_approved:appr-7",
    });
  });

  it("prefixes $insert_id with the event name to avoid cross-event collisions on shared keys", async () => {
    // Two different events share the same underlying entity id ('camp-1');
    // without the event-name prefix, a future `rewrite_approved` keyed on
    // `camp-1` would silently dedup against `sequence_activated:camp-1`.
    const { step } = makeRunningStep();

    await emitFunnelEvent(step, "emit-a", "cust", "sequence_activated", {}, "camp-1");
    await emitFunnelEvent(step, "emit-b", "cust", "rewrite_approved", {}, "camp-1");

    const calls = captureServerEventMock.mock.calls;
    expect(calls).toHaveLength(2);
    expect((calls[0]![2] as { $insert_id: string }).$insert_id).toBe(
      "sequence_activated:camp-1",
    );
    expect((calls[1]![2] as { $insert_id: string }).$insert_id).toBe(
      "rewrite_approved:camp-1",
    );
    expect((calls[0]![2] as { $insert_id: string }).$insert_id).not.toBe(
      (calls[1]![2] as { $insert_id: string }).$insert_id,
    );
  });

  it("retried emits with the same dedupKey produce the identical $insert_id (PostHog will collapse)", async () => {
    // Simulates Inngest re-running the step after a transient failure — the
    // dedupKey must be stable across attempts so PostHog drops the dup.
    const { step } = makeRunningStep();

    await emitFunnelEvent(step, "emit-first", "cust", "performance_report_sent", {}, "camp-1:2026-05-14");
    await emitFunnelEvent(step, "emit-retry", "cust", "performance_report_sent", {}, "camp-1:2026-05-14");

    const idA = (captureServerEventMock.mock.calls[0]![2] as { $insert_id: string }).$insert_id;
    const idB = (captureServerEventMock.mock.calls[1]![2] as { $insert_id: string }).$insert_id;
    expect(idA).toBe(idB);
    expect(idA).toBe("performance_report_sent:camp-1:2026-05-14");
  });

  it("different dedupKeys (different entities) produce different $insert_ids (no false-positive dedup)", async () => {
    const { step } = makeRunningStep();

    await emitFunnelEvent(step, "emit-a", "cust", "sequence_activated", {}, "batch-1");
    await emitFunnelEvent(step, "emit-b", "cust", "sequence_activated", {}, "batch-2");

    const idA = (captureServerEventMock.mock.calls[0]![2] as { $insert_id: string }).$insert_id;
    const idB = (captureServerEventMock.mock.calls[1]![2] as { $insert_id: string }).$insert_id;
    expect(idA).not.toBe(idB);
    expect(idA).toBe("sequence_activated:batch-1");
    expect(idB).toBe("sequence_activated:batch-2");
  });

  it("does NOT mutate the caller's props object when stamping $insert_id", async () => {
    // The helper must not surprise callers by mutating their props in place —
    // a caller that re-uses the same props object for two events (or asserts
    // on it after the call) would silently inherit a stale `$insert_id`.
    const { step } = makeRunningStep();
    const props = { sequence_id: "seq-1", approval_id: "appr-7" };

    await emitFunnelEvent(step, "emit-x", "cust", "rewrite_approved", props, "appr-7");

    expect(props).toEqual({ sequence_id: "seq-1", approval_id: "appr-7" });
    expect("$insert_id" in props).toBe(false);
    // The captured payload is a fresh object (no reference equality with props
    // when dedupKey is set — that contract only holds in the no-key path).
    expect(captureServerEventMock.mock.calls[0]![2]).not.toBe(props);
  });

  it("omitting dedupKey preserves reference equality on props (no-key fast path)", async () => {
    // Guards backwards-compat for callers that don't yet pass dedupKey: the
    // existing "passes props through unchanged" contract must still hold so
    // the iter 23 hardening doesn't accidentally regress the no-key path.
    const { step } = makeRunningStep();
    const props = { foo: "bar", n: 42 };

    await emitFunnelEvent(step, "emit-x", "cust", "rewrite_approved", props);

    expect(captureServerEventMock.mock.calls[0]![2]).toBe(props);
    expect("$insert_id" in (captureServerEventMock.mock.calls[0]![2] as object)).toBe(
      false,
    );
  });

  it("empty-string dedupKey is treated as 'present' (caller intent: opt in to dedup)", async () => {
    // `dedupKey !== undefined` is the gate; passing `""` is unusual but
    // unambiguous — caller asked for dedup, helper honors it. Locks the
    // boundary so a refactor to `if (dedupKey)` (truthy check) doesn't
    // silently drop dedup when a caller passes a falsy-but-defined value.
    const { step } = makeRunningStep();

    await emitFunnelEvent(step, "emit-x", "cust", "rewrite_approved", { v: 1 }, "");

    expect(captureServerEventMock).toHaveBeenCalledWith("cust", "rewrite_approved", {
      v: 1,
      $insert_id: "rewrite_approved:",
    });
  });
});
