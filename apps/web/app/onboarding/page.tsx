"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
// Import from the zero-deps subpath so this Client Component doesn't pull
// posthog-node into the browser bundle.
import { funnelInsertId } from "@copywriting-bot/shared/funnel-keys";
import { trackClient } from "../posthog-client";
import { abortableSleep, resolveCheckoutSession } from "./resolve-session";

type Step = 1 | 2 | 3 | 4 | 5;

const TOTAL_STEPS = 5 as const;

export default function OnboardingPage() {
  return (
    <Suspense fallback={null}>
      <OnboardingInner />
    </Suspense>
  );
}

function OnboardingInner() {
  const params = useSearchParams();
  const sessionId = params.get("session_id");
  const [step, setStep] = useState<Step>(1);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  useEffect(() => {
    trackClient("onboarding_started", { stripe_session_id: sessionId ?? null });
  }, [sessionId]);

  // Resolve the Stripe session → customer_id once we have a session_id.
  // Retries with backoff while the webhook is still processing. The
  // AbortController cancels both the in-flight fetch AND the pending sleep
  // when the component unmounts — no stray timers, no stale setState.
  useEffect(() => {
    if (!sessionId || customerId) return;
    const controller = new AbortController();
    void (async () => {
      const result = await resolveCheckoutSession(sessionId, {
        fetch: typeof window !== "undefined" ? window.fetch.bind(window) : fetch,
        sleep: abortableSleep,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (result.kind === "ok") setCustomerId(result.customer_id);
      else if (result.kind === "error") setResolveError(result.message);
    })();
    return () => controller.abort();
  }, [sessionId, customerId]);
  const [form, setForm] = useState({
    sending_domain: "",
    original_sequence: "",
    icp_paragraph: "",
    sample_target_companies: "",
    calendar_url: "",
    brand_voice_url: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function next() {
    setStep((s) => {
      if (s >= TOTAL_STEPS) return s;
      trackClient("onboarding_step_completed", { step: s });
      return (s + 1) as Step;
    });
  }
  function prev() {
    setStep((s) => (s > 1 ? ((s - 1) as Step) : s));
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    trackClient("onboarding_step_completed", { step: TOTAL_STEPS });
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          sample_target_companies: form.sample_target_companies
            .split(/\n|,/g)
            .map((s) => s.trim())
            .filter(Boolean),
          stripe_session_id: sessionId ?? null,
          customer_id: customerId,
        }),
      });
      const body = (await res.json()) as { error?: string; customer_id?: string };
      if (!res.ok) throw new Error(body.error ?? "Onboarding failed");
      // $insert_id matches the server-side emit in app/api/onboarding/route.ts
      // so PostHog dedupes the dual-emission. Skipped when the API didn't
      // return a customer_id (defensive — would only happen on a malformed
      // 200 response, which the route doesn't produce). `funnelInsertId` is
      // the single source of truth for the format — never inline a literal.
      trackClient("onboarding_completed", {
        customer_id: body.customer_id ?? null,
        ...(body.customer_id
          ? { $insert_id: funnelInsertId("onboarding_completed", body.customer_id) }
          : {}),
      });
      setDone(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <main className="mx-auto max-w-xl px-6 py-16">
        <h1 className="text-3xl font-bold">You're all set.</h1>
        <p className="mt-3 text-ink/70">
          The Rewrite Agent is generating your new sequence and queueing it for
          operator approval. You'll get an email when it's ready — usually within 12 hours.
        </p>
        <Link href="/dashboard" className="mt-6 inline-block rounded-md bg-ink px-5 py-3 text-cream">
          Go to dashboard →
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-sm text-ink/60">
        Step {step} of {TOTAL_STEPS}
      </p>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-ink/10">
        <div className="h-full bg-accent" style={{ width: `${(step / TOTAL_STEPS) * 100}%` }} />
      </div>

      {sessionId && !customerId && !resolveError && (
        <p className="mt-4 rounded-md bg-cream/60 px-3 py-2 text-xs text-ink/60">
          Linking your checkout… (this usually takes a few seconds)
        </p>
      )}
      {resolveError && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{resolveError}</p>
      )}

      {step === 1 && (
        <StepWrap title="Your sending domain" hint="The domain we'll send your campaign from. Must be one you own.">
          <input
            type="text"
            value={form.sending_domain}
            onChange={(e) => setForm({ ...form, sending_domain: e.target.value })}
            placeholder="outbound.acme.com"
            className="w-full rounded-md border border-ink/20 bg-white px-3 py-2"
          />
        </StepWrap>
      )}
      {step === 2 && (
        <StepWrap title="Paste your current sequence" hint="Subject lines + bodies, in any format.">
          <textarea
            rows={12}
            value={form.original_sequence}
            onChange={(e) => setForm({ ...form, original_sequence: e.target.value })}
            className="w-full rounded-md border border-ink/20 bg-white px-3 py-2 font-mono text-sm"
          />
        </StepWrap>
      )}
      {step === 3 && (
        <StepWrap title="Your ICP" hint="One paragraph + 3-10 sample target company domains.">
          <textarea
            rows={4}
            placeholder="Series A B2B SaaS, 20-200 employees, head of growth, currently using Lemlist with <3% reply rates."
            value={form.icp_paragraph}
            onChange={(e) => setForm({ ...form, icp_paragraph: e.target.value })}
            className="w-full rounded-md border border-ink/20 bg-white px-3 py-2"
          />
          <textarea
            rows={4}
            placeholder="linear.app, vercel.com, supabase.com"
            value={form.sample_target_companies}
            onChange={(e) => setForm({ ...form, sample_target_companies: e.target.value })}
            className="mt-3 w-full rounded-md border border-ink/20 bg-white px-3 py-2 font-mono text-sm"
          />
        </StepWrap>
      )}
      {step === 4 && (
        <StepWrap title="Calendar link" hint="What we'll drop in CTAs when prospects ask to chat.">
          <input
            type="url"
            value={form.calendar_url}
            onChange={(e) => setForm({ ...form, calendar_url: e.target.value })}
            placeholder="https://calendly.com/you/30min"
            className="w-full rounded-md border border-ink/20 bg-white px-3 py-2"
          />
        </StepWrap>
      )}
      {step === 5 && (
        <StepWrap title="Brand voice source" hint="A URL we can scrape to learn how you write — usually your homepage.">
          <input
            type="url"
            value={form.brand_voice_url}
            onChange={(e) => setForm({ ...form, brand_voice_url: e.target.value })}
            placeholder="https://acme.com"
            className="w-full rounded-md border border-ink/20 bg-white px-3 py-2"
          />
        </StepWrap>
      )}

      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={prev}
          disabled={step === 1}
          className="text-sm text-ink/60 hover:underline disabled:opacity-30"
        >
          ← Previous
        </button>
        {step < TOTAL_STEPS ? (
          <button
            type="button"
            onClick={next}
            className="rounded-md bg-ink px-5 py-3 text-cream hover:bg-ink/90"
          >
            Continue →
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="rounded-md bg-accent px-5 py-3 text-white hover:bg-accent/90 disabled:opacity-60"
          >
            {submitting ? "Submitting…" : "Submit & start rewrite"}
          </button>
        )}
      </div>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
    </main>
  );
}

function StepWrap({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="mt-8 space-y-3">
      <h1 className="text-3xl font-bold">{title}</h1>
      <p className="text-ink/70">{hint}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}
