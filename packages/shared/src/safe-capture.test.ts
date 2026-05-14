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

vi.mock("posthog-node", () => ({
  PostHog: vi.fn().mockImplementation(() => ({
    capture: captureMock,
    flush: flushMock,
  })),
}));

vi.mock("@sentry/nextjs", () => ({
  withScope: (cb: (scope: { setTag: (k: string, v: unknown) => void }) => void) => {
    sentryWithScopeMock(cb);
    cb({ setTag: vi.fn() });
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
