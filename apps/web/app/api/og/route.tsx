import { ImageResponse } from "next/og";
import { serviceClient } from "@copywriting-bot/db/client";
import type { RoastResultT } from "@copywriting-bot/shared/schemas";
import { scoreBand, scoreColor } from "@copywriting-bot/shared/scoring";

export const runtime = "nodejs";

/**
 * Dynamic OG image renderer for shareable roast badges.
 *
 * Request: /api/og?roast_id=<uuid>
 * Returns: 1200x630 PNG with the score + grade + share caption.
 */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const roastId = url.searchParams.get("roast_id");
  if (!roastId) {
    return new Response("roast_id required", { status: 400 });
  }

  const db = serviceClient();
  const { data, error } = await db
    .from("roasts")
    .select("result_json, overall_score, is_real_cold_email")
    .eq("id", roastId)
    .single();
  if (error || !data) {
    return new Response("Roast not found", { status: 404 });
  }

  const result = data.result_json as RoastResultT;
  const score = data.overall_score ?? 0;
  const band = scoreBand(score);
  const color = scoreColor(score);
  const caption = data.is_real_cold_email
    ? result.share_caption ?? `Got a ${band} on my cold email.`
    : `I tried to roast a non-cold email. Embarrassing.`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          background: "#fdf6ec",
          fontFamily: "system-ui, sans-serif",
          padding: 60,
        }}
      >
        <div style={{ fontSize: 24, color: "#0f172a", opacity: 0.6, letterSpacing: 4, textTransform: "uppercase" }}>
          Copywriting Bot
        </div>
        <div style={{ display: "flex", alignItems: "baseline", marginTop: 30 }}>
          <span style={{ fontSize: 220, fontWeight: 800, color, lineHeight: 1 }}>{score}</span>
          <span style={{ fontSize: 60, color: "#0f172a", opacity: 0.5, marginLeft: 16 }}>/100</span>
        </div>
        <div style={{
          marginTop: 20,
          padding: "12px 24px",
          background: "#0f172a",
          color: "#fdf6ec",
          fontSize: 36,
          borderRadius: 12,
        }}
        >
          Grade {band}
        </div>
        <div style={{ marginTop: 40, fontSize: 32, color: "#0f172a", textAlign: "center", maxWidth: 900 }}>
          “{caption}”
        </div>
        <div style={{ position: "absolute", bottom: 40, fontSize: 22, color: "#0f172a", opacity: 0.6 }}>
          copywritingbot.com / roast
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
