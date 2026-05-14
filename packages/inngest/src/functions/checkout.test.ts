import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for `runCheckoutCompleted` — the pure runner behind the
 * `stripe/checkout.completed` Inngest function. Iter 23 extracted this seam
 * so we can pin the dedup contract for `completed_checkout`:
 *
 *   - the customer row is updated to tier=full_rewrite, status=onboarding
 *   - the funnel event carries a stable `$insert_id` keyed on stripe_session_id
 *     so step retries / re-delivered webhooks can't double-count
 *   - `stripe_session_id` is included in the event properties (so PostHog can
 *     surface session-level attribution in addition to deduping)
 *   - all step.run ids are unique (Inngest enforces this at runtime)
 */

const { captureServerEventMock, serviceClientMock, funnelInsertIdMock } = vi.hoisted(() => ({
  captureServerEventMock: vi.fn(async () => undefined),
  serviceClientMock: vi.fn(),
  funnelInsertIdMock: vi.fn(
    (event: string, key: string) => `${event}:${key}`,
  ),
}));

vi.mock("@copywriting-bot/shared/observability", () => ({
  captureServerEvent: captureServerEventMock,
  funnelInsertId: funnelInsertIdMock,
}));

vi.mock("@copywriting-bot/db/client", () => ({
  serviceClient: serviceClientMock,
}));

import { runCheckoutCompleted } from "./checkout.js";

type StepRunCall = { id: string; fn: () => unknown };

function makeStep() {
  const calls: StepRunCall[] = [];
  const step = {
    run: vi.fn(async (id: string, fn: () => unknown) => {
      calls.push({ id, fn });
      return fn();
    }),
  };
  return { step, calls };
}

function wireCustomersUpdate() {
  const updateCalls: Array<{ values: Record<string, unknown>; eqArgs: Array<[string, unknown]> }> = [];

  const fromMock = vi.fn((table: string) => {
    if (table !== "customers") {
      throw new Error(`unexpected table: ${table}`);
    }
    let pendingUpdate: Record<string, unknown> | null = null;
    const eqArgs: Array<[string, unknown]> = [];
    const builder: any = {
      update: vi.fn((values: Record<string, unknown>) => {
        pendingUpdate = values;
        return builder;
      }),
      eq: vi.fn((col: string, val: unknown) => {
        eqArgs.push([col, val]);
        updateCalls.push({ values: pendingUpdate ?? {}, eqArgs: [...eqArgs] });
        return Promise.resolve({ data: null, error: null });
      }),
    };
    return builder;
  });

  return { fromMock, updateCalls };
}

const baseEvent = {
  data: {
    stripe_session_id: "cs_test_abc",
    stripe_customer_id: "cus_999",
    customer_email: "buyer@example.com",
    created_customer_id: "cust-42",
  },
};

beforeEach(() => {
  captureServerEventMock.mockClear();
  funnelInsertIdMock.mockClear();
  serviceClientMock.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe("runCheckoutCompleted", () => {
  it("upgrades the customer tier + status and emits completed_checkout with $insert_id keyed on stripe_session_id", async () => {
    const { fromMock, updateCalls } = wireCustomersUpdate();
    serviceClientMock.mockReturnValue({ from: fromMock });
    const { step, calls } = makeStep();

    const out = await runCheckoutCompleted({ event: baseEvent, step: step as any });

    expect(out).toEqual({ customer_id: "cust-42" });

    // customers row is brought up to onboarding state
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.values).toMatchObject({
      stripe_customer_id: "cus_999",
      tier: "full_rewrite",
      status: "onboarding",
    });
    expect(updateCalls[0]!.eqArgs).toEqual([["id", "cust-42"]]);

    // funnel emission carries the dedup key + session id
    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "buyer@example.com",
      "completed_checkout",
      {
        customer_id: "cust-42",
        stripe_session_id: "cs_test_abc",
        $insert_id: "completed_checkout:cs_test_abc",
      },
    );
    expect(funnelInsertIdMock).toHaveBeenCalledWith("completed_checkout", "cs_test_abc");

    // step ids are unique (Inngest contract)
    const ids = calls.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["upgrade-customer-tier", "track-funnel"]);
  });

  it("propagates a null stripe_customer_id to the customer update (Stripe omits it for guest checkouts)", async () => {
    const { fromMock, updateCalls } = wireCustomersUpdate();
    serviceClientMock.mockReturnValue({ from: fromMock });
    const { step } = makeStep();

    await runCheckoutCompleted({
      event: {
        data: {
          ...baseEvent.data,
          stripe_customer_id: null,
        },
      },
      step: step as any,
    });

    expect(updateCalls[0]!.values).toMatchObject({ stripe_customer_id: null });
  });

  it("retried invocations produce the same $insert_id so PostHog dedupes within its 24h window", async () => {
    // Step retries / re-delivered webhooks always carry the same
    // `stripe_session_id`. Two independent runs of the runner therefore
    // produce two PostHog calls — but both with the identical insert_id,
    // which is what PostHog uses to drop the second one. We assert the
    // *contract* (identical key) rather than PostHog's internal behavior.
    const { fromMock: from1 } = wireCustomersUpdate();
    const { fromMock: from2 } = wireCustomersUpdate();
    serviceClientMock.mockReturnValueOnce({ from: from1 }).mockReturnValueOnce({ from: from2 });

    const { step: stepA } = makeStep();
    const { step: stepB } = makeStep();
    await runCheckoutCompleted({ event: baseEvent, step: stepA as any });
    await runCheckoutCompleted({ event: baseEvent, step: stepB as any });

    expect(captureServerEventMock).toHaveBeenCalledTimes(2);
    const props1 = (captureServerEventMock.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2];
    const props2 = (captureServerEventMock.mock.calls[1] as unknown as [string, string, Record<string, unknown>])[2];
    expect(props1.$insert_id).toBe("completed_checkout:cs_test_abc");
    expect(props2.$insert_id).toBe(props1.$insert_id);
  });

  it("different sessions for the same buyer produce different $insert_ids (no false-positive dedup)", async () => {
    const { fromMock: from1 } = wireCustomersUpdate();
    const { fromMock: from2 } = wireCustomersUpdate();
    serviceClientMock.mockReturnValueOnce({ from: from1 }).mockReturnValueOnce({ from: from2 });

    const { step: stepA } = makeStep();
    const { step: stepB } = makeStep();
    await runCheckoutCompleted({ event: baseEvent, step: stepA as any });
    await runCheckoutCompleted({
      event: {
        data: { ...baseEvent.data, stripe_session_id: "cs_test_second" },
      },
      step: stepB as any,
    });

    const props1 = (captureServerEventMock.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2];
    const props2 = (captureServerEventMock.mock.calls[1] as unknown as [string, string, Record<string, unknown>])[2];
    expect(props1.$insert_id).not.toBe(props2.$insert_id);
    expect(props2.$insert_id).toBe("completed_checkout:cs_test_second");
  });

  it("uses injected db when provided (no serviceClient() call)", async () => {
    const { fromMock, updateCalls } = wireCustomersUpdate();
    const injectedDb = { from: fromMock } as unknown as ReturnType<typeof serviceClientMock>;
    const { step } = makeStep();

    await runCheckoutCompleted({ event: baseEvent, step: step as any, db: injectedDb });

    expect(serviceClientMock).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
  });

  it("throws when track-funnel throws so Inngest retries the step (matches sibling sendBatch contract)", async () => {
    const { fromMock } = wireCustomersUpdate();
    serviceClientMock.mockReturnValue({ from: fromMock });
    captureServerEventMock.mockRejectedValueOnce(new Error("posthog 5xx"));
    const { step } = makeStep();

    await expect(
      runCheckoutCompleted({ event: baseEvent, step: step as any }),
    ).rejects.toThrow(/posthog 5xx/);
  });
});
