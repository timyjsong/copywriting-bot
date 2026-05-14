import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@copywriting-bot/db/client";
import { inngest } from "@copywriting-bot/inngest/client";
import { captureException } from "@copywriting-bot/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  decision: z.enum(["approve", "reject", "edit_and_approve"]),
  notes: z.string().max(2_000).optional(),
  edited_payload: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Operator approval decision endpoint.
 *
 * Accepts form-encoded posts from the approvals page (simple buttons) as
 * well as JSON. Validates, updates the queue row, and emits the Inngest
 * "operator.approval" event so the waiting durable function resumes.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let parsedBody: z.infer<typeof Body>;
  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const json = await req.json();
      parsedBody = Body.parse(json);
    } else {
      const form = await req.formData();
      parsedBody = Body.parse({
        decision: form.get("decision"),
        notes: form.get("notes") ?? undefined,
      });
    }
  } catch (err) {
    return NextResponse.json({ error: "Invalid decision payload", detail: String(err) }, { status: 400 });
  }

  try {
    const db = serviceClient();
    const { error } = await db
      .from("approvals_queue")
      .update({
        status:
          parsedBody.decision === "reject"
            ? "rejected"
            : parsedBody.decision === "edit_and_approve"
              ? "edited_and_approved"
              : "approved",
        operator_action: parsedBody.decision,
        operator_notes: parsedBody.notes ?? null,
        decided_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) {
      captureException(error, { phase: "approval_persist" });
      return NextResponse.json({ error: "DB error" }, { status: 500 });
    }

    await inngest.send({
      name: "operator.approval",
      data: {
        id,
        decision: parsedBody.decision,
        notes: parsedBody.notes,
        edited_payload: parsedBody.edited_payload,
      },
    });
  } catch (err) {
    captureException(err, { phase: "approval_dispatch" });
    return NextResponse.json({ error: "Dispatch error" }, { status: 500 });
  }

  // Redirect back to the queue for form submissions; JSON callers get JSON.
  if (contentType.includes("application/json")) {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.redirect(new URL("/approvals", req.url), { status: 303 });
}
