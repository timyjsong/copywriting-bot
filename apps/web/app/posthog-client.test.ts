/**
 * Tests for posthog-client.ts — the client-side funnel emission surface.
 *
 * Iters 14–19 hardened the *server-side* emit path (captureServerEventSafe,
 * emitFunnelEventBestEffort) so a broken telemetry pipeline never 500s the user.
 * The client-side counterpart has the same contract: silent-swallow on init
 * failure, single warn-once for dev visibility, swallow exceptions from the
 * underlying posthog-js SDK. None of that was pinned until now.
 *
 * Why these tests matter: trackClient is called from interactive surfaces
 * (LandingCta, pricing CTA, roast hero). If a regression let posthog-js
 * exceptions escape, every button click on the marketing surface would throw
 * in the browser and break user flow. These tests pin the swallow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockPostHog = {
  __loaded: boolean;
  capture: ReturnType<typeof vi.fn>;
  identify: ReturnType<typeof vi.fn>;
};

const mockPosthog: MockPostHog = {
  __loaded: false,
  capture: vi.fn(),
  identify: vi.fn(),
};

vi.mock("posthog-js", () => ({
  default: mockPosthog,
}));

// posthog-client.ts holds a module-level `warned` flag. Tests that exercise
// the warn-once semantic must reset modules so the flag starts at false.
async function loadFresh() {
  vi.resetModules();
  return await import("./posthog-client");
}

describe("posthog-client / trackClient", () => {
  beforeEach(() => {
    mockPosthog.__loaded = false;
    mockPosthog.capture.mockReset();
    mockPosthog.identify.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls posthog.capture when SDK is loaded", async () => {
    mockPosthog.__loaded = true;
    const { trackClient } = await loadFresh();
    trackClient("started_roast", { surface: "landing_hero" });
    expect(mockPosthog.capture).toHaveBeenCalledTimes(1);
    expect(mockPosthog.capture).toHaveBeenCalledWith("started_roast", {
      surface: "landing_hero",
    });
  });

  it("passes empty properties object when caller omits it", async () => {
    mockPosthog.__loaded = true;
    const { trackClient } = await loadFresh();
    trackClient("visited_landing");
    expect(mockPosthog.capture).toHaveBeenCalledWith("visited_landing", {});
  });

  it("does not call capture when posthog is not loaded", async () => {
    mockPosthog.__loaded = false;
    const { trackClient } = await loadFresh();
    trackClient("started_roast", {});
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });

  it("logs once via console.debug when not loaded in a browser env", async () => {
    vi.stubGlobal("window", {} as Window);
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    mockPosthog.__loaded = false;
    const { trackClient } = await loadFresh();

    trackClient("started_roast", {});
    trackClient("started_checkout", {});
    trackClient("clicked_upsell", {});

    expect(debugSpy).toHaveBeenCalledTimes(1);
    const firstCall = debugSpy.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0]).toContain("[posthog] not initialized");
  });

  it("does not log in a server-side env (typeof window === 'undefined')", async () => {
    // Node-environment test: window is genuinely undefined here.
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    mockPosthog.__loaded = false;
    const { trackClient } = await loadFresh();

    trackClient("started_roast", {});
    trackClient("submitted_email", {});

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("swallows exceptions thrown by posthog.capture", async () => {
    mockPosthog.__loaded = true;
    mockPosthog.capture.mockImplementation(() => {
      throw new Error("posthog-js exploded");
    });
    const { trackClient } = await loadFresh();

    // The contract: trackClient must never throw — interactive UI callers
    // (LandingCta, pricing CTA) depend on this so a button click can never
    // be aborted by a telemetry failure.
    expect(() => trackClient("started_roast", {})).not.toThrow();
    expect(mockPosthog.capture).toHaveBeenCalledTimes(1);
  });

  it("forwards arbitrary property payloads verbatim", async () => {
    mockPosthog.__loaded = true;
    const { trackClient } = await loadFresh();
    const payload = {
      surface: "pricing_page",
      score: 42,
      nested: { a: 1, b: [2, 3] },
    };
    trackClient("clicked_upsell", payload);
    expect(mockPosthog.capture).toHaveBeenCalledWith("clicked_upsell", payload);
  });
});

describe("posthog-client / identifyClient", () => {
  beforeEach(() => {
    mockPosthog.__loaded = false;
    mockPosthog.capture.mockReset();
    mockPosthog.identify.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls posthog.identify when SDK is loaded", async () => {
    mockPosthog.__loaded = true;
    const { identifyClient } = await loadFresh();
    identifyClient("user-abc-123", { tier: "paid", geo: "US" });
    expect(mockPosthog.identify).toHaveBeenCalledTimes(1);
    expect(mockPosthog.identify).toHaveBeenCalledWith("user-abc-123", {
      tier: "paid",
      geo: "US",
    });
  });

  it("passes empty traits object when caller omits it", async () => {
    mockPosthog.__loaded = true;
    const { identifyClient } = await loadFresh();
    identifyClient("user-xyz");
    expect(mockPosthog.identify).toHaveBeenCalledWith("user-xyz", {});
  });

  it("does not call identify when posthog is not loaded", async () => {
    mockPosthog.__loaded = false;
    const { identifyClient } = await loadFresh();
    identifyClient("user-abc-123", {});
    expect(mockPosthog.identify).not.toHaveBeenCalled();
  });

  it("swallows exceptions thrown by posthog.identify", async () => {
    mockPosthog.__loaded = true;
    mockPosthog.identify.mockImplementation(() => {
      throw new Error("posthog identify failed");
    });
    const { identifyClient } = await loadFresh();

    expect(() => identifyClient("user-abc-123", {})).not.toThrow();
    expect(mockPosthog.identify).toHaveBeenCalledTimes(1);
  });

  it("does not emit a console.debug warning (only trackClient warns)", async () => {
    // identifyClient intentionally has no warn — it's typically called in
    // exactly one place after auth, vs trackClient which is sprinkled across
    // interactive components where dev-time visibility matters more.
    vi.stubGlobal("window", {} as Window);
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    mockPosthog.__loaded = false;
    const { identifyClient } = await loadFresh();

    identifyClient("user-abc-123", {});

    expect(debugSpy).not.toHaveBeenCalled();
  });
});
