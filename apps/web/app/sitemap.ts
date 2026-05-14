import type { MetadataRoute } from "next";
import { PLAYBOOK } from "./playbook/content";
import { publicEnv } from "@copywriting-bot/shared/env";

/**
 * Sitemap covering the marketing surface (PRD §7 Phase 5).
 *
 * Includes: landing, free tool, pricing, legal pages, playbook index + every
 * playbook entry. App / ops surfaces are intentionally excluded — they require
 * auth and shouldn't be indexed.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = publicEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const now = new Date();

  const root: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: now, changeFrequency: "weekly", priority: 1.0 },
    { url: `${base}/roast`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/pricing`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/playbook`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    { url: `${base}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/refund`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];

  const entries: MetadataRoute.Sitemap = PLAYBOOK.map((e) => ({
    url: `${base}/playbook/${e.slug}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  return [...root, ...entries];
}
