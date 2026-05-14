import type { MetadataRoute } from "next";
import { publicEnv } from "@copywriting-bot/shared/env";

export default function robots(): MetadataRoute.Robots {
  const base = publicEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/roast", "/pricing", "/playbook", "/terms", "/privacy", "/refund"],
        disallow: ["/api/", "/dashboard", "/onboarding", "/checkout"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
