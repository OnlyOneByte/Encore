// GET /api/metrics — INTERNAL processing metrics: per-step durations, end-to-end, per-model cost.
// UNGATED, deliberately and temporarily — see docs/ARCHITECTURE.md §10.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { clampDays, songDisplay } from '$lib/contract';
import { e2e, isAnecdote, perAsrModel, perProcess, perModel, perStage, perStep } from '$lib/server/jobs/metrics';

const DEFAULT_LIMIT = 2000;
const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 3650;

function clampLimit(raw: string | null): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
	return Math.min(20_000, Math.floor(n));
}

export const GET: RequestHandler = async ({ url }) => {
	const app = getApp();
	const limit = clampLimit(url.searchParams.get('limit'));
	const windowDays = clampDays(url.searchParams.get('days'), { fallback: DEFAULT_WINDOW_DAYS, max: MAX_WINDOW_DAYS });
	// Window by TIME, not a bare row count: a row-count window has no notion of its own edge, so a process straddling that edge would lose its older steps yet still report `complete: true`, silently understating its duration. A time window has a knowable edge (`windowStart`), which `perProcess`/`e2e` use to flag and drop a boundary-straddling process.
	const windowStart = app.now() - windowDays * DAY_MS;
	// EVERY sealed attempt in the window, not just successful ones — a failure rate is part of how a step performs (the rollup itself refuses to average a failure into a duration). `limit` is a hard backstop so a pathological window can never load the whole table into memory.
	const attempts = app.attempts.finishedSince(windowStart, limit);
	const totalFinished = app.attempts.countFinished();

	const steps = perStep(attempts);
	const overall = e2e(attempts, windowStart);
	const processes = perProcess(attempts, windowStart);
	const models = perModel(attempts);
	const titleOf = new Map(app.media.all().map((mm) => [mm.id, songDisplay(mm).title]));

	// Truncation is VISIBLE rather than silent: `clipped` is true when the row backstop actually bit, or any process straddled the window's older edge — either way the operator is told the sample is partial instead of reading a confident number off an incomplete set.
	const clipped = attempts.length >= limit || processes.some((c) => c.clipped);

	return json({
		// Sample size first and flagged, since it governs how much of the rest means anything — a mean
		// over two processes renders identically to a mean over two hundred unless something says so.
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
		// Measured cost per separator model, beside the rtFactor the whitelist claims: `ratioToDeclared`
		// of 1.0 means the benchmark holds on this box; 2.0 means it's twice as slow here.
		models: models.map((m) => ({ ...m, provisional: isAnecdote(m.n) })),
		// The lyrics axis has no declared cost to compare against — AsrModel carries no rtFactor until
		// someone times it on real hardware. These rows are that measurement.
		asr: perAsrModel(attempts).map((a) => ({ ...a, provisional: isAnecdote(a.n) })),
		stages: perStage(attempts), // sub-step split, from what the worker reported; empty for attempts predating that
		// Slowest complete processes, for finding the outlier rather than reasoning about the mean.
		// Titles are joined here since a media id is not a song — /api/stats does the same join.
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
