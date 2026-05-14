import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `captureServerEventSafe` is the HTTP-route variant of `captureServerEvent`.
 * It must swallow any PostHog/network failure so a transient PostHog outage
 * never fails a user-facing request. These tests defend that contract:
 *
 *  1. When PostHog is unconfigured, both variants no-op (no throw).
 *  2. When `flush()` throws, the safe variant resolves and reports to Sentry;
 *     the unsafe variant propagates (so Inngest step retries fire).
 *  3. The safe variant tags Sentry with `agent: "posthog"` + the event name,
 *     so we can correlate dropped events to outages.
 */

const captureMock = vi.fn();
const flushMock = vi.fn();
const sentryCaptureExceptionMock = vi.fn();
const sentryWithScopeMock = vi.fn();
const sentrySetTagMock = vi.fn();

vi.mock("posthog-node", () => ({
  PostHog: vi.fn().mockImplementation(() => ({
    capture: captureMock,
    flush: flushMock,
  })),
}));

vi.mock("@sentry/nextjs", () => ({
  withScope: (cb: (scope: { setTag: (k: string, v: unknown) => void }) => void) => {
    sentryWithScopeMock(cb);
    cb({ setTag: sentrySetTagMock });
  },
  captureException: sentryCaptureExceptionMock,
  addBreadcrumb: vi.fn(),
}));

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  vi.resetModules();
  captureMock.mockReset();
  flushMock.mockReset();
  sentryCaptureExceptionMock.mockReset();
  sentryWithScopeMock.mockReset();
  sentrySetTagMock.mockReset();
  process.env = { ...ORIGINAL_ENV, POSTHOG_SERVER_KEY: "phc_test" };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.clearAllMocks();
});

describe("captureServerEventSafe", () => {
  it("no-ops cleanly when POSTHOG_SERVER_KEY is absent", async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.POSTHOG_SERVER_KEY;
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const mod = await import("./observability.js");
    await expect(mod.captureServerEventSafe("user@x.com", "submitted_email")).resolves.toBeUndefined();
    expect(captureMock).not.toHaveBeenCalled();
    expect(flushMock).not.toHaveBeenCalled();
    expect(sentryCaptureExceptionMock).not.toHaveBeenCalled();
  });

  it("resolves successfully when capture + flush succeed", async () => {
    flushMock.mockResolvedValue(undefined);
    const mod = await import("./observability.js");
    await expect(
      mod.captureServerEventSafe("user@x.com", "submitted_email", { source: "web" }),
    ).resolves.toBeUndefined();
    expect(captureMock).toHaveBeenCalledWith({
      distinctId: "user@x.com",
      event: "submitted_email",
      properties: { source: "web" },
    });
    expect(flushMock).toHaveBeenCalledTimes(1);
    expect(sentryCaptureExceptionMock).not.toHaveBeenCalled();
  });

  it("swallows a flush() rejection and reports to Sentry", async () => {
    const err = new Error("posthog 503");
    flushMock.mockRejectedValueOnce(err);
    const mod = await import("./observability.js");
    await expect(
      mod.captureServerEventSafe("user@x.com", "onboarding_completed"),
    ).resolves.toBeUndefined();
    expect(sentryCaptureExceptionMock).toHaveBeenCalledTimes(1);
    expect(sentryCaptureExceptionMock).toHaveBeenCalledWith(err);
    expect(sentryWithScopeMock).toHaveBeenCalledTimes(1);
  });

  it("tags the Sentry scope with agent=posthog and the event name", async () => {
    flushMock.mockRejectedValueOnce(new Error("posthog 503"));
    const mod = await import("./observability.js");
    await mod.captureServerEventSafe("user@x.com", "onboarding_completed");
    expect(sentrySetTagMock).toHaveBeenCalledWith("agent", "posthog");
    expect(sentrySetTagMock).toHaveBeenCalledWith("event", "onboarding_completed");
    // Exactly two tags — agent + event — and nothing else. Guards against
    // a future regression that adds noise or drops one tag without anyone
    // noticing because earlier tests in this file also exercise withScope.
    expect(sentrySetTagMock).toHaveBeenCalledTimes(2);
    expect(sentryWithScopeMock).toHaveBeenCalledTimes(1);
  });

  it("swallows a synchronous capture() throw", async () => {
    captureMock.mockImplementationOnce(() => {
      throw new Error("invalid distinct_id");
    });
    const mod = await import("./observability.js");
    await expect(
      mod.captureServerEventSafe("", "submitted_email"),
    ).resolves.toBeUndefined();
    expect(sentryCaptureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it("still resolves when Sentry capture itself throws (last-resort swallow)", async () => {
    flushMock.mockRejectedValueOnce(new Error("posthog 503"));
    sentryCaptureExceptionMock.mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    const mod = await import("./observability.js");
    // The safe variant's contract is "never throw". If Sentry itself is
    // unavailable, the wrapper must still resolve.
    await expect(
      mod.captureServerEventSafe("user@x.com", "completed_checkout"),
    ).resolves.toBeUndefined();
  });

  it("still resolves when Sentry capture returns a rejected promise (no unhandled rejection)", async () => {
    // Some Sentry transports return a thenable rather than throwing. Without
    // an explicit .catch in observability.ts, the rejection would escape as
    // an unhandled rejection on the Node process. The guard must keep that
    // from happening.
    flushMock.mockRejectedValueOnce(new Error("posthog 503"));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // mockImplementationOnce (not mockReturnValueOnce) so the rejected
      // promise is created at call time — same microtask as the .catch attach
      // in observability.ts. mockReturnValueOnce would create it at setup,
      // letting Node fire unhandledRejection before we register the catch.
      sentryCaptureExceptionMock.mockImplementationOnce(() =>
        Promise.reject(new Error("sentry transport rejected")),
      );
      const mod = await import("./observability.js");
      await expect(
        mod.captureServerEventSafe("user@x.com", "completed_checkout"),
      ).resolves.toBeUndefined();
      // Yield a couple of ticks so any unhandled-rejection event would have
      // fired by now.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not throw even if console.error itself throws (last-resort log fails)", async () => {
    // captureException's final-fallback log can in theory throw (broken
    // stderr). The wrapper must still resolve so route handlers don't see
    // a 500. Use vi.spyOn (auto-restored between tests) so an unexpected
    // assertion failure here can't leak the broken console.error into
    // sibling tests in this file.
    flushMock.mockRejectedValueOnce(new Error("posthog 503"));
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("stderr broken");
    });
    const mod = await import("./observability.js");
    await expect(
      mod.captureServerEventSafe("user@x.com", "completed_checkout"),
    ).resolves.toBeUndefined();
  });
});

describe("captureServerEvent (unsafe — for Inngest steps)", () => {
  it("propagates a flush() rejection so step.run retries fire", async () => {
    const err = new Error("posthog 503");
    flushMock.mockRejectedValueOnce(err);
    const mod = await import("./observability.js");
    await expect(
      mod.captureServerEvent("user@x.com", "rewrite_approved"),
    ).rejects.toThrow("posthog 503");
  });
});

describe("emitFunnelEventBestEffort", () => {
  /**
   * Iter-18 primitive that collapses the duplicated funnel-emission DiD block
   * routes were carrying. Contract: never throws. Telemetry is gravy; the
   * user's 200 is sacred.
   */
  it("happy path — flushes the event via PostHog and tags nothing extra", async () => {
    flushMock.mockResolvedValue(undefined);
    const mod = await import("./observability.js");
    await expect(
      mod.emitFunnelEventBestEffort(
        "user@x.com",
        "submitted_email",
        { source: "web" },
        { phase: "roast_funnel_emission" },
      ),
    ).resolves.toBeUndefined();
    expect(captureMock).toHaveBeenCalledWith({
      distinctId: "user@x.com",
      event: "submitted_email",
      properties: { source: "web" },
    });
    expect(flushMock).toHaveBeenCalledTimes(1);
    // No Sentry on the happy path.
    expect(sentryCaptureExceptionMock).not.toHaveBeenCalled();
  });

  it("swallows a flush() rejection (delegates to captureServerEventSafe — Sentry tags agent=posthog)", async () => {
    flushMock.mockRejectedValueOnce(new Error("posthog 503"));
    const mod = await import("./observability.js");
    await expect(
      mod.emitFunnelEventBestEffort(
        "user@x.com",
        "submitted_email",
        { source: "web" },
        { phase: "roast_funnel_emission" },
      ),
    ).resolves.toBeUndefined();
    // The inner safe wrapper handles it — Sentry tag is `agent=posthog`, not
    // the funnel phase. The phase tag only kicks in if the safe wrapper itself
    // escapes (see funnel.test.ts).
    expect(sentrySetTagMock).toHaveBeenCalledWith("agent", "posthog");
    expect(sentrySetTagMock).toHaveBeenCalledWith("event", "submitted_email");
    // Negative-space pin: phase tag is OWNED by the outer catch in
    // emitFunnelEventBestEffort. On the inner-wrapper path it must NOT fire,
    // else a future regression that double-tags Sentry from both layers
    // would slip through. Hard contract: only the call site whose
    // captureServerEventSafe escapes gets the phase tag.
    expect(sentrySetTagMock).not.toHaveBeenCalledWith("phase", "roast_funnel_emission");
  });

  it("never throws when both PostHog AND Sentry are completely broken (full transport collapse)", async () => {
    // Worst-case composition: flush rejects → safe wrapper catches → tries
    // captureException → Sentry throws → captureException's inner catch falls
    // through to console.error → console.error throws too. The primitive must
    // still resolve cleanly. This pins the contract end-to-end through every
    // layer, no spying needed.
    flushMock.mockRejectedValueOnce(new Error("posthog 503"));
    sentryCaptureExceptionMock.mockImplementation(() => {
      throw new Error("sentry down");
    });
    // Use vi.spyOn (auto-restored between tests) so an unexpected assertion
    // failure here can't leak the broken console.error into sibling tests.
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("stderr broken");
    });
    const mod = await import("./observability.js");
    await expect(
      mod.emitFunnelEventBestEffort(
        "user@x.com",
        "completed_checkout",
        {},
        { phase: "checkout_funnel_emission" },
      ),
    ).resolves.toBeUndefined();
  });

  it("forwards properties verbatim — no key drops, no key additions", async () => {
    flushMock.mockResolvedValue(undefined);
    const mod = await import("./observability.js");
    const props = { source: "web", utm_campaign: "roast-launch", custom: { nested: 1 } };
    await mod.emitFunnelEventBestEffort(
      "user@x.com",
      "submitted_email",
      props,
      { phase: "roast_funnel_emission" },
    );
    expect(captureMock).toHaveBeenCalledWith({
      distinctId: "user@x.com",
      event: "submitted_email",
      properties: props,
    });
  });
});
