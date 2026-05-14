export type Tone = "neutral" | "pending" | "good" | "bad";

export type Sequence = {
  id: string;
  version: number;
  status: string;
  created_at: string;
  approved_at: string | null;
} | null;

export type Campaign = {
  id: string;
  status: string;
  warmup_status: string | null;
  daily_cap: number;
  started_at: string | null;
} | null;

export type Snapshot = {
  snapshot_date: string;
  opens: number;
  replies: number;
  meetings_booked: number;
  baseline_reply_rate: number | null;
  current_reply_rate: number | null;
  uplift_pct: number | null;
} | null;

export function renderSequenceBody(seq: Sequence | undefined): string {
  if (!seq) return "Pending — finish onboarding to start your rewrite.";
  if (seq.status === "draft") return "Draft submitted. Rewrite Agent is generating.";
  if (seq.status === "pending_approval") return "Rewrite drafted — awaiting operator approval.";
  if (seq.status === "approved")
    return `Rewrite approved on ${seq.approved_at ? new Date(seq.approved_at).toLocaleDateString() : "—"}.`;
  if (seq.status === "active") return "Live — being sent on your domain.";
  if (seq.status === "rejected") return "Rewrite was rejected. We're regenerating.";
  return `Status: ${seq.status}`;
}

export function sequenceTone(status: string | undefined): Tone {
  if (!status) return "neutral";
  if (status === "approved" || status === "active") return "good";
  if (status === "rejected") return "bad";
  return "pending";
}

export function renderCampaignBody(c: Campaign | undefined): string {
  if (!c) return "Awaiting rewrite approval.";
  if (c.status === "warmup") return `Warmup in progress (${c.warmup_status ?? "scheduled"}). Daily cap: ${c.daily_cap}.`;
  if (c.status === "sending")
    return `Live. Daily cap: ${c.daily_cap}. Started ${c.started_at ? new Date(c.started_at).toLocaleDateString() : "—"}.`;
  if (c.status === "paused") return "Paused.";
  if (c.status === "ended") return "Campaign ended.";
  if (c.status === "failed") return "Campaign failed — operator is on it.";
  return `Status: ${c.status}`;
}

export function campaignTone(status: string | undefined): Tone {
  if (!status) return "neutral";
  if (status === "sending") return "good";
  if (status === "failed") return "bad";
  return "pending";
}

export function renderPerformanceBody(s: Snapshot | undefined): string {
  if (!s) return "No data yet — campaign hasn't sent its first batch.";
  const uplift = s.uplift_pct == null ? "—" : `${s.uplift_pct.toFixed(1)}%`;
  return `As of ${s.snapshot_date}: ${s.replies} replies, ${s.meetings_booked} meetings. Uplift ${uplift}.`;
}

export function performanceTone(uplift: number | null): Tone {
  if (uplift == null) return "neutral";
  if (uplift >= 10) return "good";
  if (uplift < 0) return "bad";
  return "pending";
}
