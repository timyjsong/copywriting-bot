"use client";

import Link from "next/link";
import { useEffect } from "react";
import { trackClient } from "./posthog-client";

/**
 * Landing-page CTA block. Lives on the client so we can:
 *  - emit `visited_landing` once on mount
 *  - tag the "Get a free roast" button as `started_roast` from landing
 *  - tag the "See pricing" button as `clicked_upsell`
 *
 * Server-rendered marketing copy stays in `page.tsx`; this component only
 * owns the interactive surface.
 */
export function LandingCta() {
  useEffect(() => {
    trackClient("visited_landing", { surface: "marketing_home" });
  }, []);

  return (
    <div className="mt-8 flex flex-wrap gap-3">
      <Link
        href="/roast"
        onClick={() => trackClient("started_roast", { surface: "landing_hero" })}
        className="rounded-md bg-ink px-5 py-3 text-cream hover:bg-ink/90"
      >
        Get a free roast of your sequence →
      </Link>
      <Link
        href="/pricing"
        onClick={() => trackClient("clicked_upsell", { surface: "landing_hero" })}
        className="rounded-md border border-ink/20 px-5 py-3 hover:bg-ink/5"
      >
        See pricing
      </Link>
    </div>
  );
}
