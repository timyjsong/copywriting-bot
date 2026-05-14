"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { identifyClient, trackClient } from "../posthog-client";

export default function CheckoutPage() {
  return (
    <Suspense fallback={null}>
      <CheckoutInner />
    </Suspense>
  );
}

function CheckoutInner() {
  const params = useSearchParams();
  const fromRoast = params.get("from_roast") ?? undefined;
  const [email, setEmail] = useState("");
  const [stage, setStage] = useState<"idle" | "redirecting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function start(ev: React.FormEvent) {
    ev.preventDefault();
    setStage("redirecting");
    setError(null);
    trackClient("started_checkout", { from_roast_id: fromRoast ?? null });
    identifyClient(email, { last_action: "started_checkout" });
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, from_roast_id: fromRoast }),
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        throw new Error(body.error ?? "Failed to create checkout session");
      }
      window.location.href = body.url;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  }

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <Link href="/pricing" className="text-sm text-ink/60 hover:underline">
        ← Back
      </Link>
      <h1 className="mt-6 text-3xl font-bold">Start checkout</h1>
      <p className="mt-3 text-ink/70">
        $297 one-time. Next you'll be redirected to Stripe to pay, then to onboarding.
      </p>
      <form onSubmit={start} className="mt-8 space-y-4">
        <label htmlFor="email" className="block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-ink/20 bg-white px-3 py-2"
        />
        <button
          type="submit"
          disabled={stage === "redirecting"}
          className="rounded-md bg-ink px-5 py-3 text-cream hover:bg-ink/90 disabled:opacity-60"
        >
          {stage === "redirecting" ? "Redirecting…" : "Pay $297"}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    </main>
  );
}
