"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  campaignTone,
  performanceTone,
  renderCampaignBody,
  renderPerformanceBody,
  renderSequenceBody,
  sequenceTone,
  type Campaign,
  type Sequence,
  type Snapshot,
  type Tone,
} from "./helpers";

/**
 * Customer dashboard. Pre-auth MVP renders status keyed by `?email=` from
 * the URL. Phase 2 wires this to the Supabase session JWT via RLS.
 */

type Status = {
  found: boolean;
  customer?: {
    id: string;
    email: string;
    status: string;
    tier: string;
    company_domain: string | null;
    created_at: string;
  };
  sequence?: Sequence;
  campaign?: Campaign;
  latest_snapshot?: Snapshot;
};

export default function CustomerDashboardPage() {
  return (
    <Suspense fallback={null}>
      <DashboardInner />
    </Suspense>
  );
}

function DashboardInner() {
  const params = useSearchParams();
  const email = params.get("email") ?? "";
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!email) return;
    setLoading(true);
    setError(null);
    fetch(`/api/dashboard/status?email=${encodeURIComponent(email)}`)
      .then(async (res) => {
        if (res.status === 404) {
          setStatus({ found: false });
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "Could not load");
        }
        setStatus((await res.json()) as Status);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [email]);

  if (!email) {
    return (
      <main className="mx-auto max-w-xl px-6 py-16">
        <h1 className="text-3xl font-bold">Your campaign</h1>
        <p className="mt-3 text-ink/70">
          Visit your dashboard via the link in your welcome email, or append{" "}
          <code className="rounded bg-ink/5 px-1.5 py-0.5">?email=you@company.com</code> to this URL.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <h1 className="text-3xl font-bold">Your campaign</h1>
      <p className="mt-2 text-ink/70">
        Status for <span className="font-mono">{email}</span>
      </p>

      {loading && <p className="mt-6 text-ink/60">Loading…</p>}
      {error && <p className="mt-6 text-red-600">{error}</p>}
      {status && !status.found && (
        <div className="mt-10 rounded-xl border border-dashed border-ink/20 bg-white p-10 text-center text-ink/60">
          We don't have a campaign on this email yet. If you just paid, give the webhook a few seconds.
        </div>
      )}

      {status?.found && status.customer && (
        <>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            <Card
              title="Sequence"
              body={renderSequenceBody(status.sequence)}
              tone={sequenceTone(status.sequence?.status)}
            />
            <Card
              title="Send infrastructure"
              body={renderCampaignBody(status.campaign)}
              tone={campaignTone(status.campaign?.status)}
            />
            <Card
              title="Performance"
              body={renderPerformanceBody(status.latest_snapshot)}
              tone={performanceTone(status.latest_snapshot?.uplift_pct ?? null)}
            />
          </div>

          <div className="mt-10 rounded-xl border border-ink/10 bg-white p-6">
            <h2 className="text-lg font-semibold">Account</h2>
            <dl className="mt-3 grid gap-2 text-sm text-ink/70 md:grid-cols-2">
              <div>
                <dt className="text-ink/50">Customer status</dt>
                <dd className="font-mono">{status.customer.status}</dd>
              </div>
              <div>
                <dt className="text-ink/50">Tier</dt>
                <dd className="font-mono">{status.customer.tier}</dd>
              </div>
              <div>
                <dt className="text-ink/50">Sending domain</dt>
                <dd className="font-mono">{status.customer.company_domain ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-ink/50">Member since</dt>
                <dd className="font-mono">{new Date(status.customer.created_at).toLocaleDateString()}</dd>
              </div>
            </dl>
            <Link href="/refund" className="mt-4 inline-block text-sm text-accent hover:underline">
              Refund policy →
            </Link>
          </div>
        </>
      )}
    </main>
  );
}

function Card({ title, body, tone }: { title: string; body: string; tone: Tone }) {
  const accent =
    tone === "good"
      ? "border-green-200 bg-green-50"
      : tone === "bad"
        ? "border-red-200 bg-red-50"
        : tone === "pending"
          ? "border-amber-200 bg-amber-50"
          : "border-ink/10 bg-white";
  return (
    <div className={`rounded-xl border p-6 ${accent}`}>
      <h3 className="text-sm uppercase tracking-widest text-ink/60">{title}</h3>
      <p className="mt-2 text-base">{body}</p>
    </div>
  );
}
