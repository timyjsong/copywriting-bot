import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@copywriting-bot/db/client";
import { captureException } from "@copywriting-bot/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight dashboard status endpoint. Returns the customer's current
 * status, sequence approval state, and most recent performance snapshot.
 * Pre-auth MVP: keyed by email (passed in the query string). Phase 2 will
 * gate this on the Supabase session JWT.
 */

const Query = z.object({
  email: z.string().email(),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse({ email: url.searchParams.get("email") ?? "" });
  if (!parsed.success) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  try {
    const db = serviceClient();
    const { data: customer } = await db
      .from("customers")
      .select("id, email, status, tier, company_domain, created_at")
      .eq("email", parsed.data.email)
      .maybeSingle();

    if (!customer) {
      return NextResponse.json({ found: false }, { status: 404 });
    }

    const [{ data: sequence }, { data: campaign }, { data: snapshot }] = await Promise.all([
      db
        .from("sequences")
        .select("id, version, status, created_at, approved_at")
        .eq("customer_id", customer.id)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from("campaigns")
        .select("id, status, warmup_status, daily_cap, started_at")
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from("performance_snapshots")
        .select("snapshot_date, opens, replies, meetings_booked, baseline_reply_rate, current_reply_rate, uplift_pct")
        .eq("customer_id", customer.id)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    return NextResponse.json({
      found: true,
      customer,
      sequence: sequence ?? null,
      campaign: campaign ?? null,
      latest_snapshot: snapshot ?? null,
    });
  } catch (err) {
    captureException(err, { phase: "dashboard_status" });
    return NextResponse.json({ error: "Could not load status" }, { status: 500 });
  }
}
