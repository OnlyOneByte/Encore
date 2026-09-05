// Shared display helpers for the two operator metrics surfaces (routes/metrics/+page.svelte and
// routes/metrics/[mediaId]/+page.svelte). Extracted because both pages had grown their OWN copy of
// each of these, and the copies had begun to drift — the defect this closes is a new job type or
// worker stage being taught to one page's label map and silently showing the raw DB name on the
// other. One source, imported twice, cannot disagree with itself.
//
// This vocabulary is deliberately SEPARATE from the guest-facing labels in @encore/shared: the
// operator page says "removing vocals", the phone says "Separating vocals". They serve different
// readers (an operator debugging throughput vs a singer waiting on their song), so they are kept
// apart on purpose rather than forced into one table.

/**
 * ms to a human duration. Null renders as an em dash, never as 0 — a missing timing is "not
 * recorded", not "took no time".
 *
 * Each branch rounds to the precision it DISPLAYS before deciding which branch applies, because
 * doing it the other way round printed values that had already carried into the next unit: at
 * 119_600ms the minute branch rendered "1m 60s" (`Math.round(59.6)` is 60), and at 59_960ms the
 * seconds branch rendered "60.0s" (`(59.96).toFixed(1)` is "60.0") instead of "1m 0s". Both were
 * one defect wearing two faces, so the rounding happens once, up front, and the split is exact.
 */
export function dur(ms: number | null): string {
	if (ms === null) return '—';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	// Tenths of a second: the unit the sub-minute branch prints. 600 tenths IS a minute, so a value
	// that rounds up to it belongs to the minute branch rather than being shown as "60.0s".
	const tenths = Math.round(ms / 100);
	if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
	const totalSec = Math.round(ms / 1000);
	return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
}

/**
 * Plain names for the internal job types. `fetch`/`stems`/`align` are what the code calls them and
 * what the database stores; they describe the implementation, not what the step DOES, and these
 * pages are read by a person. An unmapped type falls through to its raw name rather than vanishing.
 */
export const STEP_LABELS: Record<string, string> = {
	fetch: 'download',
	stems: 'remove vocals',
	align: 'time lyrics',
	score: 'pitch track',
	'stems-upgrade': 'redo vocals'
};
export const stepLabel = (jobType: string): string => STEP_LABELS[jobType] ?? jobType;

/**
 * The worker's own sub-step names. `separating`/`aligning` describe the code, not the work. Operator
 * wording ("removing vocals"); the guest-facing equivalent lives in @encore/shared and reads
 * differently on purpose (see the module note above).
 */
export const STAGE_LABELS: Record<string, string> = {
	downloading: 'downloading',
	separating: 'removing vocals',
	aligning: 'timing lyrics'
};
export const stageLabel = (stage: string): string => STAGE_LABELS[stage] ?? stage;
