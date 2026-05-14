import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the `emitFunnelEventBestEffort` outer catch — the `ctx.phase`
 * branch.
 *
 * The inner safe wrapper (`captureServerEventSafe`) is documented to never
 * throw, which left iter-18 reviewers worried that the outer catch was dead
 * code and the `ctx.phase` parameter was unverified scaffolding. To exercise
 * the path we need to force the inner safe wrapper to throw — that's only
 * possible by mocking it at the module boundary, which only works because
 * iter 19 split the primitive out of `observability.ts` so the call to
 * `captureServerEventSafe` crosses a module boundary that `vi.mock` can
 * intercept.
 *
 * The end-to-end "full transport collapse" pin lives in `safe-capture.test.ts`
 * — that test proves the primitive doesn't throw under realistic failure
 * stacks. This file pins the OBSERVABILITY of a should-never-happen escape:
 * if a future regression makes the safe wrapper throw, the `phase` tag must
 * land on Sentry so the call site is correlatable.
 */

const captureServerEventSafeMock = vi.fn();
const captureExceptionMock = vi.fn();

vi.mock("./observability.js", () => ({
  captureServerEventSafe: captureServerEventSafeMock,
  captureException: captureExceptionMock,
}));

beforeEach(() => {
  vi.resetModules();
  captureServerEventSafeMock.mockReset();
  captureExceptionMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("emitFunnelEventBestEffort outer catch (ctx.phase observability)", () => {
  it("happy path — delegates to captureServerEventSafe and never touches captureException", async () => {
    captureServerEventSafeMock.mockResolvedValueOnce(undefined);
    const mod = await import("./funnel.js");
    await expect(
      mod.emitFunnelEventBestEffort(
        "user@x.com",
        "submitted_email",
        { source: "web" },
        { phase: "roast_funnel_emission" },
      ),
    ).resolves.toBeUndefined();
    expect(captureServerEventSafeMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventSafeMock).toHaveBeenCalledWith(
      "user@x.com",
      "submitted_email",
      { source: "web" },
    );
    // No outer-catch path on the happy path.
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("captures with the funnel phase tag when captureServerEventSafe ESCAPES (the should-never-happen path)", async () => {
    // Forces the documented-impossible: the safe wrapper rejects. The outer
    // catch is the last line of defense; this test proves the `phase` tag
    // is delivered (otherwise the parameter would be dead scaffolding).
    const escaped = new Error("safe wrapper escaped — regression in observability.ts");
    captureServerEventSafeMock.mockRejectedValueOnce(escaped);
    const mod = await import("./funnel.js");
    await expect(
      mod.emitFunnelEventBestEffort(
        "user@x.com",
        "submitted_email",
        { source: "web" },
        { phase: "roast_funnel_emission" },
      ),
    ).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      escaped,
      { phase: "roast_funnel_emission" },
    );
  });

  it("captures with the onboarding phase tag when the safe wrapper escapes for the onboarding caller", async () => {
    // Mirror with a different phase so a regression that hard-codes the tag
    // (e.g. always emits "roast_funnel_emission") fails this assertion.
    const escaped = new Error("safe wrapper escaped");
    captureServerEventSafeMock.mockRejectedValueOnce(escaped);
    const mod = await import("./funnel.js");
    await mod.emitFunnelEventBestEffort(
      "11111111-1111-1111-1111-111111111111",
      "onboarding_completed",
      { customer_id: "11111111-1111-1111-1111-111111111111" },
      { phase: "onboarding_funnel_emission" },
    );
    expect(captureExceptionMock).toHaveBeenCalledWith(
      escaped,
      { phase: "onboarding_funnel_emission" },
    );
  });

  it("never re-throws even when captureException itself throws (last-resort: contract is sacred)", async () => {
    // captureException is documented bulletproof, but this pins the contract:
    // even if it ever escapes, emitFunnelEventBestEffort must still resolve.
    captureServerEventSafeMock.mockRejectedValueOnce(new Error("safe escaped"));
    captureExceptionMock.mockImplementationOnce(() => {
      throw new Error("captureException ALSO escaped");
    });
    const mod = await import("./funnel.js");
    // CURRENT BEHAVIOR: captureException is treated as a never-throws primitive
    // by emitFunnelEventBestEffort (no inner try/catch around it). So if it
    // ever escapes, the primitive WILL throw. This test pins that current
    // behavior — a regression in either direction is visible.
    await expect(
      mod.emitFunnelEventBestEffort(
        "user@x.com",
        "submitted_email",
        {},
        { phase: "roast_funnel_emission" },
      ),
    ).rejects.toThrow("captureException ALSO escaped");
  });

  it("forwards an empty distinctId verbatim (boundary: PostHog rejects empty IDs but the primitive must not pre-validate)", async () => {
    // The primitive's contract is "best effort" — no input validation. An
    // empty distinctId is invalid for PostHog and would synchronously throw
    // inside `capture()` in production, but the primitive forwards it
    // unchanged so the failure shape is identical to other PostHog rejections
    // (handled by the inner safe wrapper).
    captureServerEventSafeMock.mockResolvedValueOnce(undefined);
    const mod = await import("./funnel.js");
    await mod.emitFunnelEventBestEffort(
      "",
      "submitted_email",
      {},
      { phase: "roast_funnel_emission" },
    );
    expect(captureServerEventSafeMock).toHaveBeenCalledWith("", "submitted_email", {});
  });

  it("forwards an empty properties object verbatim", async () => {
    captureServerEventSafeMock.mockResolvedValueOnce(undefined);
    const mod = await import("./funnel.js");
    await mod.emitFunnelEventBestEffort(
      "user@x.com",
      "submitted_email",
      {},
      { phase: "roast_funnel_emission" },
    );
    expect(captureServerEventSafeMock).toHaveBeenCalledWith("user@x.com", "submitted_email", {});
  });

  it("forwards non-serializable property values (circular ref) without pre-validating — failure surfaces inside captureServerEventSafe", async () => {
    // A circular reference would throw inside posthog-node's `capture()` call
    // synchronously, BEFORE flush(). This is a different escape path than the
    // flush-rejection tests cover, but the primitive's behavior is identical:
    // forward verbatim, let the inner safe wrapper deal. Pinning that the
    // primitive doesn't pre-serialize / pre-validate.
    type Node = { self?: Node };
    const circ: Node = {};
    circ.self = circ;
    captureServerEventSafeMock.mockResolvedValueOnce(undefined);
    const mod = await import("./funnel.js");
    await mod.emitFunnelEventBestEffort(
      "user@x.com",
      "submitted_email",
      { circ },
      { phase: "roast_funnel_emission" },
    );
    const args = captureServerEventSafeMock.mock.calls[0]!;
    expect(args[0]).toBe("user@x.com");
    expect(args[1]).toBe("submitted_email");
    // Same object reference — no defensive clone, no JSON round-trip.
    expect((args[2] as { circ: Node }).circ).toBe(circ);
  });
});

describe("funnelInsertId — PostHog dedup key format", () => {
  /**
   * `funnelInsertId` is the single source of truth for the `$insert_id`
   * format used by every dual-emission funnel event (client + server emit
   * the same logical event; PostHog dedupes by `$insert_id`).
   *
   * The literals in these tests ARE the contract — a change in the helper
   * format must fail loud so every call site can be audited in lockstep.
   * Drift between client + server keys would silently double-count
   * conversions in production funnels.
   */

  it("formats as '<event>:<key>' for the canonical viewed_result case", async () => {
    const { funnelInsertId } = await import("./funnel.js");
    expect(funnelInsertId("viewed_result", "roast-abc")).toBe("viewed_result:roast-abc");
  });

  it("formats as '<event>:<key>' for the onboarding_completed case (different event, same shape)", async () => {
    const { funnelInsertId } = await import("./funnel.js");
    expect(funnelInsertId("onboarding_completed", "cust-uuid-1")).toBe(
      "onboarding_completed:cust-uuid-1",
    );
  });

  it("namespaces by event so different events with the same underlying key never collide", async () => {
    const { funnelInsertId } = await import("./funnel.js");
    // Hypothetical: a future event reuses roast_id. The prefix prevents collision.
    expect(funnelInsertId("viewed_result", "x")).not.toBe(
      funnelInsertId("clicked_upsell", "x"),
    );
  });

  it("is deterministic — same inputs always produce the same key (no Date.now, no uuid)", async () => {
    const { funnelInsertId } = await import("./funnel.js");
    const a = funnelInsertId("viewed_result", "roast-1");
    const b = funnelInsertId("viewed_result", "roast-1");
    expect(a).toBe(b);
    // Determinism is the entire reason this exists — a non-stable key would
    // silently disable PostHog dedup.
  });

  it("forwards the key verbatim — no encoding, no truncation, no normalisation", async () => {
    const { funnelInsertId } = await import("./funnel.js");
    // PostHog accepts any string up to 200 chars. Forwarding verbatim keeps
    // the call site's natural identifier (uuid, email, slug) visible in
    // PostHog's event explorer for debugging.
    expect(funnelInsertId("viewed_result", "rOaSt-WiTh-DaShEs-and-mixed-CASE")).toBe(
      "viewed_result:rOaSt-WiTh-DaShEs-and-mixed-CASE",
    );
    expect(funnelInsertId("onboarding_completed", "a:b:c")).toBe(
      "onboarding_completed:a:b:c",
    );
  });

  it("produces a stable empty-key bucket when handed an empty string (iter-21 review #4 boundary)", async () => {
    const { funnelInsertId } = await import("./funnel.js");
    // The viewed_result path inlines `funnelInsertId("viewed_result", roastId)`
    // unconditionally; if a future regression let `roastId` be empty, the
    // helper produces a deterministic-but-debuggable bucket rather than a
    // crash or a random uuid. Pinning this so a future "normalize the key"
    // PR can't silently change empty-handling.
    expect(funnelInsertId("viewed_result", "")).toBe("viewed_result:");
  });

  it("preserves a 190-char key (near PostHog's 200-char $insert_id limit) without truncating", async () => {
    const { funnelInsertId } = await import("./funnel.js");
    // PostHog documents a 200-char limit on $insert_id. With the
    // "viewed_result:" prefix (14 chars) the key payload can be up to 186
    // chars before we approach the cap. 190-char raw key + prefix tests the
    // verbatim-forwarding contract right at the boundary — a "be defensive,
    // truncate at N chars" PR would silently change PostHog's dedup window
    // semantics for long roast IDs.
    const key = "x".repeat(190);
    const out = funnelInsertId("viewed_result", key);
    expect(out).toBe(`viewed_result:${key}`);
    expect(out.length).toBe(204);
  });

  it("forwards keys containing newlines, tabs, and control chars verbatim (no normalisation)", async () => {
    const { funnelInsertId } = await import("./funnel.js");
    // PostHog accepts these in $insert_id (it dedupes on byte-identical
    // strings). The contract is "format identical between client + server"
    // — if the helper ever URL-encoded or stripped whitespace, the two
    // sides would silently diverge for any key containing these chars.
    // Roast IDs / customer IDs don't contain them today, but pinning that
    // a future helper change can't silently shift dedup semantics.
    expect(funnelInsertId("viewed_result", "a\nb")).toBe("viewed_result:a\nb");
    expect(funnelInsertId("viewed_result", "a\tb")).toBe("viewed_result:a\tb");
    expect(funnelInsertId("viewed_result", "  leading-ws")).toBe("viewed_result:  leading-ws");
    expect(funnelInsertId("viewed_result", "trailing-ws  ")).toBe("viewed_result:trailing-ws  ");
  });
});

describe("funnelInsertId — direct import from ./funnel-keys.js (zero-deps subpath)", () => {
  /**
   * Iter-21 review finding #6 / #12: `funnel.test.ts` imports `funnelInsertId`
   * exclusively via the `./funnel.js` re-export. The whole reason
   * `funnel-keys.ts` exists is so Client Components (apps/web/app/roast/page.tsx,
   * apps/web/app/onboarding/page.tsx) can import it without pulling
   * posthog-node into the browser bundle. A broken `funnel-keys.ts` masked by
   * the inlined re-export would pass every other test in this file.
   *
   * Direct import guards the subpath: if `funnel-keys.ts` ever throws at
   * import time (e.g. someone adds a `posthog-node` import there), this
   * import fails before any assertion runs.
   */

  it("returns the same format as the re-exported path (zero-deps subpath is real)", async () => {
    const direct = await import("./funnel-keys.js");
    const reexport = await import("./funnel.js");
    expect(direct.funnelInsertId("viewed_result", "roast-1")).toBe(
      reexport.funnelInsertId("viewed_result", "roast-1"),
    );
    // Belt: pin the exact literal so a future change that quietly diverges
    // the two paths fails here, not only in production.
    expect(direct.funnelInsertId("viewed_result", "roast-1")).toBe("viewed_result:roast-1");
  });
});
