// GET /api/metrics — the INTERNAL processing metrics: per-step durations, end-to-end, per-model cost.
//
// UNGATED, deliberately and temporarily. There is no admin identity in Encore: the only auth axis is
// "anonymous" vs "any singer with a cookie", and any phone on the LAN can POST /api/join to become
// the latter — so a singer check here would be theatre, not a gate. The honest options were a shared
// secret or nothing, and nothing was chosen for now.
//
// WHAT THAT EXPOSES, so the decision can be revisited with the facts: worker ids, model and backend
// names, host details, and terminal error strings. No singer identities and no media bytes. Bind the
// server to a trusted interface, or add a token, when that stops being acceptable.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { e2e, isAnecdote, perAsrModel, perCook, perModel, perStage, perStep } from '$server/jobs/metrics';

const DEFAULT_LIMIT = 2000;

export const GET: RequestHandler = async ({ url }) => {
	const app = getApp();
	const limit = clampLimit(url.searchParams.get('limit'));
	// EVERY sealed attempt, not just successful ones: a failure rate is part of how a step performs,
	// and the rollup already refuses to average a failure into a duration.
	const attempts = app.attempts.allFinished(limit);

	const steps = perStep(attempts);
	const overall = e2e(attempts);
	const models = perModel(attempts);

	return json({
		// Sample size first, and flagged, because it governs how much of the rest means anything. A
		// mean over two cooks renders identically to a mean over two hundred unless something says so.
		sample: {
			attempts: attempts.length,
			cooks: overall.n,
			provisional: isAnecdote(overall.n)
		},
		steps: steps.map((s) => ({ ...s, provisional: isAnecdote(s.n) })),
		e2e: overall,
		// Measured cost per separator model, beside the rtFactor the whitelist claims. `ratioToDeclared`
		// of 1.0 means the benchmark holds on this box; 2.0 means it is twice as slow here, which is the
		// number needed to size a party rather than a pass/fail.
		models: models.map((m) => ({ ...m, provisional: isAnecdote(m.n) })),
		// The lyrics axis has no declared cost anywhere to compare against — AsrModel refuses to carry
		// an rtFactor until someone times it on real hardware. These rows are that measurement.
		asr: perAsrModel(attempts).map((a) => ({ ...a, provisional: isAnecdote(a.n) })),
		// Sub-step split, from what the worker reported. Empty for attempts predating that.
		stages: perStage(attempts),
		// Slowest complete cooks, for finding the outlier rather than reasoning about the mean.
		slowestCooks: perCook(attempts).filter((c) => c.complete).slice(0, 10),
		workers: app.workers.list().map((w) => ({
			workerId: w.workerId,
			capabilities: w.capabilities,
			concurrency: w.concurrency,
			slotsFree: w.slotsFree,
			host: w.host ?? null
		}))
	});
};

function clampLimit(raw: string | null): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
	return Math.min(20_000, Math.floor(n));
}
