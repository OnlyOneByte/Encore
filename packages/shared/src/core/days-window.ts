// The `days` read-window rule, shared by the /api/stats and /api/metrics endpoints.
//
// WHY THIS EXISTS. `/api/stats` and `/api/metrics` were born in one commit and grown by copying
// each other, so each carried its own `clampDays` — same algorithm, different constants, with
// nothing forcing the two copies to stay in sync. One copy's docstring also stated a lower
// bound of 1 that its code never applied: `Math.floor(0.5)` is `0`, so `?days=0.5` survived the
// `<= 0` gate and collapsed the window to zero length. This is the single implementation both routes
// call; the differing constants (a 30-day public trend vs a 7-day operator window) stay at each call
// site, since those differ on purpose and are not the duplication.

/**
 * Parse and clamp a `days` query parameter to `[1, max]`.
 *
 * A non-finite or non-positive value (including a fractional value in `(0, 1)`, which would floor to
 * 0) falls back to `fallback`. Otherwise the value is floored and clamped to `[1, max]` — the lower
 * bound of 1 is what makes the endpoints' documented window bound true rather than aspirational.
 */
export function clampDays(raw: string | null, opts: { fallback: number; max: number }): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return opts.fallback;
	return Math.max(1, Math.min(opts.max, Math.floor(n)));
}
