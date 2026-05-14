"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import posthog from "posthog-js";

/**
 * Client-side PostHog provider. Mounted once at the root layout. Initializes
 * the JS SDK if NEXT_PUBLIC_POSTHOG_KEY is present, captures `$pageview` on
 * client-side navigation (App Router), and exposes a global init guard so it
 * is safe across HMR and double-renders.
 *
 * Funnel events fired from feature components (started_roast, started_checkout,
 * clicked_upsell, etc.) flow through `trackClient` in ./posthog-client.ts.
 */

let _initialized = false;

function ensureInit(): boolean {
  if (_initialized) return true;
  if (typeof window === "undefined") return false;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return false;
  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
    capture_pageview: false,
    capture_pageleave: true,
    persistence: "localStorage+cookie",
    autocapture: false,
  });
  _initialized = true;
  return true;
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (!ensureInit()) return;
    const url = pathname + (search.toString() ? `?${search.toString()}` : "");
    if (lastPath.current === url) return;
    lastPath.current = url;
    posthog.capture("$pageview", { $current_url: window.location.origin + url });
  }, [pathname, search]);

  return <>{children}</>;
}
