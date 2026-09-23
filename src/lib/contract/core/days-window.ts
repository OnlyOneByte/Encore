// The `days` read-window rule, shared by every endpoint that takes one. The differing per-route constants
// (a public trend window versus a shorter operator one) stay at each CALL SITE, because those differ on
// purpose and are not the duplication this removes.

/**
 * Parse and clamp a `days` query parameter to `[1, max]`.
 *
 * The LOWER BOUND OF 1 is load-bearing, not decoration: a fractional value in `(0, 1)` clears a `<= 0` gate
 * and then floors to 0, collapsing the window to zero length. A non-finite or non-positive value falls back.
 */
export function clampDays(raw: string | null, opts: { fallback: number; max: number }): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return opts.fallback;
	return Math.max(1, Math.min(opts.max, Math.floor(n)));
}
