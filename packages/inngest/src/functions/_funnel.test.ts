import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureServerEventMock } = vi.hoisted(() => ({
  captureServerEventMock: vi.fn(
    async (_customerId: string, _event: string, _props: Record<string, unknown>) => undefined,
  ),
}));

vi.mock("@copywriting-bot/shared/observability", () => ({
  captureServerEvent: captureServerEventMock,
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
});
