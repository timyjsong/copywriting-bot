import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
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
