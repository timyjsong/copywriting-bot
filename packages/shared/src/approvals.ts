/**
 * Approval-queue helpers: pure functions shared by ops UI + tests.
 *
 * Two responsibilities live here:
 *
 *  1. Time / SLA formatters (`timeAgo`, `timeUntil`, `slaOverdue`,
 *     `formatDuration`) — small, boundary-sensitive, easy to break in UI code.
 *  2. Per-approval-type payload normalizers (`normalizeApprovalPayload`)
 *     that turn an unknown `payload_json` into a typed summary with explicit
 *     defaults. The ops page used to switch on `type` inline and silently
 *     render `undefined` when payloads drifted; routing through these
 *     normalizers makes the schema drift visible and tested.
 *
 * Adding a new approval type = add a `NormalizedSummary` variant + handler
 * in `normalizeApprovalPayload`, and a renderer in the ops registry. No
 * other file changes.
 */

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function timeAgo(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "just now";
  const diff = now - t;
  // Future dates (clock skew) collapse to "just now" rather than "-3m".
  if (diff < 0) return "just now";
  return formatDuration(diff) + " ago";
}

export function timeUntil(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "just now";
  return formatDuration(Math.abs(t - now));
}

export function slaOverdue(iso: string, now: number = Date.now()): boolean {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return t < now;
}

export function groupCounts<T extends { type: string }>(items: readonly T[]): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    acc[item.type] = (acc[item.type] ?? 0) + 1;
    return acc;
  }, {});
}

export type ApprovalType =
  | "rewrite"
  | "send_batch"
  | "refund"
  | "outbound_email"
  | "support_reply";

export type RewriteSummary = {
  kind: "rewrite";
  playbook: string;
  band: string;
  emailCount: number;
  preview: ReadonlyArray<{ step: string; subject: string; bodySnippet: string }>;
  hiddenCount: number;
};

export type SendBatchSummary = {
  kind: "send_batch";
  prospectCount: number;
  campaignId: string;
};

export type RefundSummary = {
  kind: "refund";
  amountUsd: string;
  reason: string;
};

export type OutboundEmailSummary = {
  kind: "outbound_email";
  subject: string;
  to: string;
};

export type SupportReplySummary = {
  kind: "support_reply";
  threadId: string;
};

export type UnknownSummary = {
  kind: "unknown";
  type: string;
};

export type NormalizedSummary =
  | RewriteSummary
  | SendBatchSummary
  | RefundSummary
  | OutboundEmailSummary
  | SupportReplySummary
  | UnknownSummary;

function asRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}

function asString(v: unknown, fallback = "—"): string {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

const PREVIEW_LIMIT = 2;
const BODY_SNIPPET_LIMIT = 180;

export function normalizeApprovalPayload(type: string, payload: unknown): NormalizedSummary {
  const p = asRecord(payload);

  if (type === "rewrite") {
    const emails = Array.isArray(p.emails) ? (p.emails as unknown[]) : [];
    const preview = emails.slice(0, PREVIEW_LIMIT).map((raw) => {
      const e = asRecord(raw);
      return {
        step: asString(e.step),
        subject: asString(e.subject),
        bodySnippet: asString(e.body, "").slice(0, BODY_SNIPPET_LIMIT),
      };
    });
    return {
      kind: "rewrite",
      playbook: asString(p.playbook_used),
      band: asString(p.expected_reply_rate_band),
      emailCount: emails.length,
      preview,
      hiddenCount: Math.max(0, emails.length - PREVIEW_LIMIT),
    };
  }
  if (type === "send_batch") {
    return {
      kind: "send_batch",
      prospectCount: asNumber(p.prospect_count, 0),
      campaignId: asString(p.campaign_id),
    };
  }
  if (type === "refund") {
    const cents = asNumber(p.amount, 0);
    return {
      kind: "refund",
      amountUsd: (cents / 100).toFixed(2),
      reason: asString(p.reason),
    };
  }
  if (type === "outbound_email") {
    return {
      kind: "outbound_email",
      subject: asString(p.subject),
      to: asString(p.to),
    };
  }
  if (type === "support_reply") {
    return {
      kind: "support_reply",
      threadId: asString(p.thread_id),
    };
  }
  return { kind: "unknown", type };
}
