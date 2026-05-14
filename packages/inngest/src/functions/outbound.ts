import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";
import { outbound } from "@copywriting-bot/agents";

/**
 * outboundDailySource — daily cron that sources B2B SaaS prospects, generates
 * personalized cold emails via the Outbound Agent, and queues them for
 * operator approval (PRD §4 "bot eats own dog food" + §5.1 Outbound Agent).
 *
 * Apollo enrichment is intentionally optional in MVP — if APOLLO_API_KEY is
 * missing, we pull from `prospects` table (queued/enriched) instead. This keeps
 * the cron usable in environments without an Apollo subscription while still
 * exercising the full pipeline.
 */
export const outboundDailySource = inngest.createFunction(
  { id: "outbound-daily-source", name: "Outbound daily prospect source + queue" },
  { cron: "TZ=UTC 0 13 * * 1-5" }, // 13:00 UTC, weekdays
  async ({ step }) => {
    const db = serviceClient();

    const prospects = await step.run("load-prospects", async () => {
      const { data, error } = await db
        .from("prospects")
        .select("id, name, role, company, company_domain, signal_json")
        .eq("status", "queued")
        .limit(25);
      if (error) throw error;
      return (data ?? []).map((p) => ({
        id: p.id,
        name: p.name ?? "",
        role: p.role ?? "",
        company: p.company ?? "",
        company_domain: p.company_domain ?? "",
        signal: typeof p.signal_json === "string"
          ? p.signal_json
          : JSON.stringify(p.signal_json ?? "")
              .slice(0, 500),
      }));
    });

    if (prospects.length === 0) return { status: "no_prospects" };

    const generated = await step.run("generate-outbound", async () => {
      const res = await outbound.runOutboundAgent(prospects);
      if (!res.ok) throw new Error(res.error);
      return res.result;
    });

    const approvalIds = await step.run("queue-for-approval", async () => {
      const inserts = generated.messages.map((m) => ({
        type: "outbound_email" as const,
        entity_id: m.prospect_id,
        payload_json: m as unknown as object,
        status: "pending" as const,
      }));
      const { data, error } = await db.from("approvals_queue").insert(inserts).select("id");
      if (error) throw error;
      return (data ?? []).map((r) => r.id);
    });

    return { queued: approvalIds.length };
  },
);
