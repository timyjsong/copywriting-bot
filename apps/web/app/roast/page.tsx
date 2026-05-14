"use client";

import { useState } from "react";
import Link from "next/link";
import type { RoastResultT } from "@copywriting-bot/shared/schemas";
import { dimensionLabel, scoreBand, scoreColor, summariseResult } from "@copywriting-bot/shared/scoring";

type Stage = "idle" | "submitting" | "result" | "error";

export default function RoastPage() {
  const [email, setEmail] = useState("");
  const [sequence, setSequence] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [result, setResult] = useState<RoastResultT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roastId, setRoastId] = useState<string | null>(null);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setStage("submitting");
    setError(null);
    try {
      const res = await fetch("/api/roast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, sequence, source: "web" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      const body = (await res.json()) as { result: RoastResultT; roast_id: string };
      setResult(body.result);
      setRoastId(body.roast_id);
      setStage("result");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <Link href="/" className="text-sm text-ink/60 hover:underline">
        ← Back to home
      </Link>
      <h1 className="mt-6 text-4xl font-bold">Roast my cold email</h1>
      <p className="mt-3 text-ink/70">
        Paste your B2B SaaS cold-email sequence. We'll score it on 6 dimensions
        and rewrite the worst email. Free, takes ~30 seconds.
      </p>

      {stage !== "result" && (
        <form onSubmit={submit} className="mt-10 space-y-6">
          <div>
            <label htmlFor="email" className="block text-sm font-medium">
              Where should we send the result?
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="mt-2 w-full rounded-md border border-ink/20 bg-white px-3 py-2"
            />
          </div>
          <div>
            <label htmlFor="sequence" className="block text-sm font-medium">
              Your sequence (paste it verbatim)
            </label>
            <textarea
              id="sequence"
              required
              minLength={40}
              value={sequence}
              onChange={(e) => setSequence(e.target.value)}
              rows={14}
              placeholder={"Subject: ...\n\nHi {{first_name}}, ..."}
              className="mt-2 w-full rounded-md border border-ink/20 bg-white px-3 py-2 font-mono text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={stage === "submitting"}
            className="rounded-md bg-ink px-5 py-3 text-cream hover:bg-ink/90 disabled:opacity-60"
          >
            {stage === "submitting" ? "Roasting…" : "Roast it"}
          </button>
          {stage === "error" && error && (
            <p className="text-sm text-red-600">{error}</p>
          )}
          <p className="text-xs text-ink/50">
            By submitting you agree to our <Link href="/terms" className="underline">terms</Link> and{" "}
            <Link href="/privacy" className="underline">privacy policy</Link>. We email you the result and
            occasional product updates; unsubscribe any time.
          </p>
        </form>
      )}

      {stage === "result" && result && <RoastResultView result={result} roastId={roastId} email={email} />}
    </main>
  );
}

function RoastResultView({
  result,
  roastId,
  email,
}: {
  result: RoastResultT;
  roastId: string | null;
  email: string;
}) {
  if (!result.is_real_cold_email) {
    return (
      <section className="mt-10 rounded-xl border border-ink/10 bg-white p-8">
        <p className="text-sm uppercase tracking-widest text-accent">Not a cold email</p>
        <h2 className="mt-2 text-2xl font-semibold">We can't roast this</h2>
        <p className="mt-4 text-ink/80">{result.refusal_reason}</p>
        <p className="mt-6 text-sm text-ink/60">
          The Roast Agent only scores genuine cold-outbound sequences for B2B SaaS. Try pasting an actual outbound
          email and we'll grade it properly.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-10 space-y-8">
      <div className="rounded-xl border border-ink/10 bg-white p-8">
        <p className="text-sm uppercase tracking-widest text-accent">Score</p>
        <div className="mt-2 flex items-baseline gap-3">
          <span className="text-6xl font-bold" style={{ color: scoreColor(result.overall_score) }}>
            {result.overall_score}
          </span>
          <span className="text-2xl text-ink/60">/ 100</span>
          <span className="ml-3 rounded-md bg-ink px-3 py-1 text-sm text-cream">{scoreBand(result.overall_score)}</span>
        </div>
        <p className="mt-3 text-ink/80">{summariseResult(result)}</p>
        {roastId && (
          <p className="mt-4 text-xs text-ink/40">
            Share:{" "}
            <a href={`/api/og?roast_id=${roastId}`} className="underline" target="_blank" rel="noreferrer">
              shareable badge
            </a>{" "}
            (we emailed the link to {email})
          </p>
        )}
      </div>

      <div className="rounded-xl border border-ink/10 bg-white p-8">
        <h3 className="text-lg font-semibold">Per-dimension scores</h3>
        <ul className="mt-4 space-y-3">
          {result.per_dimension.map((d) => (
            <li key={d.dimension} className="flex items-start gap-4">
              <span
                className="mt-1 w-12 shrink-0 rounded px-2 py-1 text-center text-sm font-mono text-white"
                style={{ backgroundColor: scoreColor(d.score * 10) }}
              >
                {d.score}
              </span>
              <div>
                <div className="font-medium">{dimensionLabel(d.dimension)}</div>
                <div className="text-sm text-ink/70">{d.rationale}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {result.rewrite_preview && (
        <div className="rounded-xl border border-ink/10 bg-white p-8">
          <h3 className="text-lg font-semibold">Rewrite preview (worst email)</h3>
          <div className="mt-4 rounded-md bg-cream p-4 font-mono text-sm">
            <div>
              <strong>Subject:</strong> {result.rewrite_preview.subject}
            </div>
            <pre className="mt-3 whitespace-pre-wrap break-words">{result.rewrite_preview.body}</pre>
          </div>
          {result.rewrite_preview.changed_phrases.length > 0 && (
            <div className="mt-4 text-sm text-ink/70">
              <div className="font-medium">Key changes:</div>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {result.rewrite_preview.changed_phrases.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl border-2 border-accent bg-cream p-8">
        <p className="text-sm uppercase tracking-widest text-accent">Want the whole sequence?</p>
        <h3 className="mt-2 text-2xl font-semibold">
          $297 one-time: full rewrite + 30 days of send infra.
        </h3>
        <p className="mt-3 text-ink/80">
          We rebuild every email, stand up Smartlead on your domain, and run it for 30 days. If we miss the
          21-day reply-rate target we rewrite again, free.
        </p>
        <Link
          href={`/checkout?from_roast=${roastId ?? ""}`}
          className="mt-6 inline-block rounded-md bg-ink px-5 py-3 text-cream hover:bg-ink/90"
        >
          Start checkout →
        </Link>
      </div>
    </section>
  );
}
