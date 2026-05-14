import type { NormalizedSummary } from "@copywriting-bot/shared/approvals";

/**
 * Renderer registry for approval-queue summaries. Each approval type maps
 * to a small React function component that consumes a normalized summary
 * (from `@copywriting-bot/shared/approvals`). Adding a new approval type
 * means: (1) extend `NormalizedSummary` + `normalizeApprovalPayload` in
 * shared, (2) drop a new renderer here. No edits to the page itself.
 */

type Renderer = (summary: NormalizedSummary) => React.ReactNode;

const RewriteRenderer: Renderer = (s) => {
  if (s.kind !== "rewrite") return null;
  return (
    <div className="mt-3 space-y-2 text-sm">
      <div className="text-ink/70">
        Playbook: <strong>{s.playbook}</strong> · expected band <strong>{s.band}</strong> ·{" "}
        {s.emailCount} emails
      </div>
      {s.preview.map((email, i) => (
        <div key={i} className="rounded bg-ink/5 px-3 py-2 text-xs">
          <div>
            <strong>Step {email.step}:</strong> {email.subject}
          </div>
          <div className="mt-1 line-clamp-2 text-ink/70">{email.bodySnippet}…</div>
        </div>
      ))}
      {s.hiddenCount > 0 && (
        <div className="text-xs text-ink/50">+ {s.hiddenCount} more emails (see raw payload)</div>
      )}
    </div>
  );
};

const SendBatchRenderer: Renderer = (s) => {
  if (s.kind !== "send_batch") return null;
  return (
    <div className="mt-3 text-sm text-ink/70">
      {s.prospectCount} prospects · campaign <span className="font-mono">{s.campaignId}</span>
    </div>
  );
};

const RefundRenderer: Renderer = (s) => {
  if (s.kind !== "refund") return null;
  return (
    <div className="mt-3 text-sm text-ink/70">
      Amount: <strong>${s.amountUsd}</strong> · reason: {s.reason}
    </div>
  );
};

const OutboundEmailRenderer: Renderer = (s) => {
  if (s.kind !== "outbound_email") return null;
  return (
    <div className="mt-3 text-sm text-ink/70">
      Subject: <strong>{s.subject}</strong> · to {s.to}
    </div>
  );
};

const SupportReplyRenderer: Renderer = (s) => {
  if (s.kind !== "support_reply") return null;
  return (
    <div className="mt-3 text-sm text-ink/70">
      Reply draft for thread <span className="font-mono">{s.threadId}</span>
    </div>
  );
};

export const approvalRenderers: Record<NormalizedSummary["kind"], Renderer> = {
  rewrite: RewriteRenderer,
  send_batch: SendBatchRenderer,
  refund: RefundRenderer,
  outbound_email: OutboundEmailRenderer,
  support_reply: SupportReplyRenderer,
  unknown: () => null,
};

export function ApprovalSummary({ summary }: { summary: NormalizedSummary }) {
  const Render = approvalRenderers[summary.kind];
  return Render(summary);
}
