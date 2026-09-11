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
import { clampDays, songDisplay } from '@encore/shared';
import { e2e, isAnecdote, perAsrModel, perProcess, perModel, perStage, perStep } from '$server/jobs/metrics';

const DEFAULT_LIMIT = 2000;

export const GET: RequestHandler = async ({ url }) => {
	const app = getApp();
	const limit = clampLimit(url.searchParams.get('limit'));
	const windowDays = clampDays(url.searchParams.get('days'), { fallback: DEFAULT_WINDOW_DAYS, max: MAX_WINDOW_DAYS });
	// Window by TIME, not by a bare row count. The old row-count window (`allFinished(limit)`) had no
	// notion of its own edge: at the cap it returned N rows with nothing saying more existed, and a
	// process straddling that edge lost its older steps yet still reported `complete: true` and measured
	// its span from only the surviving rows — silently understating that process's duration (#472). A
	// time window has a knowable edge (`windowStart`), which `perProcess`/`e2e` use to flag and drop a
	// boundary-straddling process, and it buys the one query Encore lacked: "the last N days".
	const windowStart = app.now() - windowDays * DAY_MS;
	// EVERY sealed attempt in the window, not just successful ones: a failure rate is part of how a
	// step performs, and the rollup already refuses to average a failure into a duration. `limit`
	// stays as a hard backstop so a pathological window can never load the whole table into memory.
	const attempts = app.attempts.finishedSince(windowStart, limit);
	const totalFinished = app.attempts.countFinished();

	const steps = perStep(attempts);
	const overall = e2e(attempts, windowStart);
	const processes = perProcess(attempts, windowStart);
	const models = perModel(attempts);
	const titleOf = new Map(app.media.all().map((mm) => [mm.id, songDisplay(mm).title]));

	// Truncation is now VISIBLE rather than silent: `clipped` is true when the row backstop actually
	// bit (more rows finished in the window than we fetched) or when any process straddled the window's
	// older edge. Either way the operator is told the sample is partial instead of reading a confident
	// number off an incomplete set.
	const clipped = attempts.length >= limit || processes.some((c) => c.clipped);

	return json({
		// Sample size first, and flagged, because it governs how much of the rest means anything. A
		// mean over two processes renders identically to a mean over two hundred unless something says so.
		// `total` is the honest denominator behind the windowed `attempts`, and `clipped` says whether
		// the window or the row backstop dropped anything.
		sample: {
			attempts: attempts.length,
			total: totalFinished,
			windowDays,
			clipped,
			processes: overall.n,
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
		// Slowest complete processes, for finding the outlier rather than reasoning about the mean. Titles are
		// joined here because a media id is not a song: an operator navigating a list of "m-zombie" has
		// to open each one to find out what it is. /api/stats already does the same join.
		slowestProcesses: processes
			.filter((c) => c.complete)
			.slice(0, 10)
			.map((c) => ({ ...c, title: titleOf.get(c.mediaId) ?? null })),
		workers: app.workers.list().map((w) => ({
			workerId: w.workerId,
			capabilities: w.capabilities,
			concurrency: w.concurrency,
			slotsFree: w.slotsFree,
			host: w.host ?? null
		}))
	});
};

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 3650;

function clampLimit(raw: string | null): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
	return Math.min(20_000, Math.floor(n));
}
