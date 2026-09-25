// Shared display helpers for the two operator metrics surfaces, so a new job type or worker stage cannot be taught
// to one page's label map and silently show the raw database name on the other. This vocabulary is deliberately
// SEPARATE from the guest-facing labels in the contract: different readers, kept apart on purpose.

import { SEPARATOR_ENGINES } from '$lib/contract';

/** ms to a human duration. Null renders as an em dash, NEVER as 0 — a missing timing is "not recorded", not "took
 * no time". EACH BRANCH ROUNDS TO THE PRECISION IT DISPLAYS BEFORE the branch is chosen: the other order prints
 * values that have already carried into the next unit, giving "1m 60s" and "60.0s". */
export function dur(ms: number | null): string {
	if (ms === null) return '—';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	// Tenths of a second, the unit the sub-minute branch prints: 600 tenths IS a minute, so a value that rounds up to
	// it belongs to the minute branch.
	const tenths = Math.round(ms / 100);
	if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
	const totalSec = Math.round(ms / 1000);
	return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
}

/** A step's computer time as a PERCENTAGE of the song's own length. Null renders as an em dash, never as 0% — a rate
 * that was never measured is "no data". A percentage rather than a multiplier, because a multiplier needs the reader
 * to know what it multiplies and every surface showing one had to caption it. */
export function pct(v: number | null): string {
	return v === null ? '—' : `${Math.round(v * 100)}%`;
}

/** A count with its noun agreeing: an operator is a person too, and a page rendering "1 runs" reads as a page nobody
 * looked at. `plural` defaults to adding an s; pass it for an irregular noun rather than teaching this function
 * English. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
	return `${n} ${n === 1 ? singular : plural}`;
}

/** A measured rate against the one its model claims, NAMED rather than left as a ratio: a bare multiplier needs a
 * legend to say which direction is bad, and the direction was otherwise carried by cell colour alone. Within half a
 * percent of parity it reads "matches", because "0% slower" is a true statement that sounds like a complaint. */
export function vsClaimed(ratio: number | null): string {
	if (ratio === null) return '—';
	if (Math.abs(ratio - 1) < 0.005) return 'matches';
	return ratio > 1 ? `${Math.round((ratio - 1) * 100)}% slower` : `${Math.round((1 - ratio) * 100)}% faster`;
}

/** Plain names for the internal job types, which describe the implementation rather than what the step DOES. An
 * unmapped type falls through to its raw name rather than vanishing. */
export const STEP_LABELS: Record<string, string> = {
	fetch: 'download',
	stems: 'remove vocals',
	align: 'time lyrics',
	score: 'pitch track',
	'stems-upgrade': 'redo vocals'
};
export const stepLabel = (jobType: string): string => STEP_LABELS[jobType] ?? jobType;

/** The worker's own sub-step names, in operator wording; the guest-facing equivalent differs on purpose. */
export const STAGE_LABELS: Record<string, string> = {
	downloading: 'downloading',
	separating: 'removing vocals',
	aligning: 'timing lyrics'
};
export const stageLabel = (stage: string): string => STAGE_LABELS[stage] ?? stage;

/** A separator pairing as a person reads it: the raw form leaks the database's engine and model ids, and it is the
 * widest cell on the page. The REGISTRY's own label is the source, so a model cannot be added without one, and an id
 * the registry does not know falls through to the raw pair — a row written by an older build stays readable. */
export function separatorLabel(engineId: string | null, modelId: string | null): string {
	const model = SEPARATOR_ENGINES.flatMap((e) => e.models).find((m) => m.id === modelId);
	if (model) return model.label;
	return `${engineId ?? '—'} / ${modelId ?? '—'}`;
}

/** A wall-clock timestamp in the viewer's LOCAL zone: a sliced-off ISO string is UTC, which west of Greenwich rolls
 * the printed DATE for any evening party. Built from Intl PARTS rather than `toLocaleString`, so the layout is fixed
 * and sortable whatever the host locale, and the optional `timeZone` is what makes it testable against an instant. */
// Constructing a formatter is expensive and the audit trail renders one stamp per row, so it is cached per zone.
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
