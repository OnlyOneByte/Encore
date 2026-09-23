// Shared display helpers for the two operator metrics surfaces. One source, imported twice, so a new job
// type or worker stage cannot be taught to one page's label map and silently show the raw database name on
// the other.
//
// This vocabulary is deliberately SEPARATE from the guest-facing labels in the contract: the operator page
// says "removing vocals", the phone says "Separating vocals". Different readers, kept apart on purpose.

import { SEPARATOR_ENGINES } from '$lib/contract';

/**
 * ms to a human duration. Null renders as an em dash, NEVER as 0 — a missing timing is "not recorded", not
 * "took no time".
 *
 * EACH BRANCH ROUNDS TO THE PRECISION IT DISPLAYS BEFORE the branch is chosen. The other order prints values
 * that have already carried into the next unit, giving "1m 60s" and "60.0s", so the rounding happens once,
 * up front, and the split is exact.
 */
export function dur(ms: number | null): string {
	if (ms === null) return '—';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	// Tenths of a second, the unit the sub-minute branch prints: 600 tenths IS a minute, so a value that
	// rounds up to it belongs to the minute branch.
	const tenths = Math.round(ms / 100);
	if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
	const totalSec = Math.round(ms / 1000);
	return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
}

/**
 * How much computer time a step cost, as a PERCENTAGE of the song's own length. Null renders as an em dash,
 * never as 0% — a rate that was never measured is "no data", not "instant".
 *
 * A percentage rather than a multiplier, because a multiplier needs the reader to know what it multiplies and
 * every surface showing one had to caption it; a percentage beside a header naming the whole needs none.
 */
export function pct(v: number | null): string {
	return v === null ? '—' : `${Math.round(v * 100)}%`;
}

/**
 * A count with its noun agreeing. Every guest-facing surface already picks the singular at one; an operator
 * is a person too, and a page rendering "1 runs" reads as a page nobody looked at.
 *
 * `plural` defaults to adding an s, which covers every noun these pages use. Pass it for an irregular one
 * rather than teaching this function English.
 */
export function count(n: number, singular: string, plural = `${singular}s`): string {
	return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * A measured rate against the one its model claims, NAMED rather than left as a ratio: a bare multiplier
 * needs a legend to say which direction is bad, and the direction was otherwise carried by cell colour
 * alone, so a reader who cannot separate the two hues had nothing.
 *
 * Within half a percent of parity it reads "matches", because "0% slower" is a true statement that sounds
 * like a complaint.
 */
export function vsClaimed(ratio: number | null): string {
	if (ratio === null) return '—';
	if (Math.abs(ratio - 1) < 0.005) return 'matches';
	return ratio > 1 ? `${Math.round((ratio - 1) * 100)}% slower` : `${Math.round((1 - ratio) * 100)}% faster`;
}

/**
 * Plain names for the internal job types, which describe the implementation rather than what the step DOES.
 * An unmapped type falls through to its raw name rather than vanishing.
 */
export const STEP_LABELS: Record<string, string> = {
	fetch: 'download',
	stems: 'remove vocals',
	align: 'time lyrics',
	score: 'pitch track',
	'stems-upgrade': 'redo vocals'
};
export const stepLabel = (jobType: string): string => STEP_LABELS[jobType] ?? jobType;

/** The worker's own sub-step names, in operator wording; the guest-facing equivalent reads differently on
 * purpose — see the module note. */
export const STAGE_LABELS: Record<string, string> = {
	downloading: 'downloading',
	separating: 'removing vocals',
	aligning: 'timing lyrics'
};
export const stageLabel = (stage: string): string => STAGE_LABELS[stage] ?? stage;

/**
 * A separator pairing as a person reads it. The raw form leaks the database's engine and model ids — the same
 * class of leak the step labels exist to stop — and it is the widest cell on the page, which is the
 * difference between a table that fits a phone and one that scrolls.
 *
 * The REGISTRY's own label is the source, so a model cannot be added without one. An id the registry does not
 * know falls through to the raw pair rather than vanishing: an operator reading a row written by an older
 * build must still be able to tell what ran.
 */
export function separatorLabel(engineId: string | null, modelId: string | null): string {
	const model = SEPARATOR_ENGINES.flatMap((e) => e.models).find((m) => m.id === modelId);
	if (model) return model.label;
	return `${engineId ?? '—'} / ${modelId ?? '—'}`;
}

/**
 * A wall-clock timestamp in the viewer's LOCAL zone. The audit log is a timeline read to reconstruct how a
 * song came to be, so the times must match the operator's own clock — a sliced-off ISO string is UTC, which
 * west of Greenwich rolls the printed DATE for any evening party.
 *
 * Built from Intl PARTS rather than `toLocaleString`, so the layout is fixed and sortable regardless of the
 * host locale while the zone still resolves to the viewer's by default. The optional `timeZone` argument is
 * what makes this deterministically testable against a pinned instant.
 */
// Constructing a formatter is comparatively expensive and the audit trail renders one stamp per row, so it is
// cached per resolved zone. The config is otherwise fixed, so a cached formatter is byte-identical.
const stampFormatters = new Map<string, Intl.DateTimeFormat>();
function stampFormatter(timeZone?: string): Intl.DateTimeFormat {
	const key = timeZone ?? '';
	let fmt = stampFormatters.get(key);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat('en-US', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false,
			...(timeZone ? { timeZone } : {})
		});
		stampFormatters.set(key, fmt);
	}
	return fmt;
}

export function localStamp(ms: number, timeZone?: string): string {
	const parts = stampFormatter(timeZone).formatToParts(new Date(ms));
	const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
	// hour '24' is Intl's midnight rendering under hour12:false; normalise it to '00'.
	const hour = g('hour') === '24' ? '00' : g('hour');
	return `${g('year')}-${g('month')}-${g('day')} ${hour}:${g('minute')}:${g('second')}`;
}
