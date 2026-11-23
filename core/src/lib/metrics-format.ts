// Shared display helpers for the two operator metrics surfaces, so a new job type or worker stage cannot be taught
// to one page's label map and silently show the raw database name on the other. This vocabulary is deliberately
// SEPARATE from the guest-facing labels in the contract: different readers, kept apart on purpose.

import { SEPARATOR_ENGINES } from '$lib/contract';

/** ms to a human duration. Null renders as an em dash, NEVER as 0 — a missing timing is "not recorded", not "took
 * no time". EACH BRANCH ROUNDS TO THE PRECISION IT DISPLAYS BEFORE the branch is chosen: the other order prints
 * values that have already carried into the next unit, giving "1m 60s" and "60.0s". Each branch also prints its OWN
 * unit and the one below, which is why the hour branch drops seconds — "19h 58m 36s" is three units of precision
 * nobody reads off a dashboard. */
export function dur(ms: number | null): string {
	if (ms === null) return '—';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	// Tenths of a second, the unit the sub-minute branch prints: 600 tenths IS a minute, so a value that rounds up to
	// it belongs to the minute branch.
	const tenths = Math.round(ms / 100);
	if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
	// Whole minutes, the unit the hour branch prints: 60 of them IS an hour. Without this branch an overnight
	// re-process printed "1198m 36s", which is a number the reader has to divide.
	const totalMin = Math.round(ms / 60_000);
	if (totalMin >= 60) return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
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

/* ── The audit/attempt vocabulary ────────────────────────────────────────────
   Moved here from `routes/metrics/[mediaId]/+page.svelte` and `routes/metrics/+page.svelte`, for the reason this
   module's header already gives: a label map living in a `.svelte` file is a label map no test can reach, and the
   two operator surfaces then drift apart one word at a time. */

/** A run or an attempt outcome, in words. Anything unrecognised falls through to `running`, which is what an
 *  in-flight row genuinely is — never a blank cell. */
const OUTCOME_LABELS: Record<string, string> = {
	ready: 'done',
	failed: 'failed',
	abandoned: 'gave up, retried',
	canceled: 'canceled',
	running: 'running'
};
export const outcomeLabel = (outcome: string | null): string =>
	OUTCOME_LABELS[outcome ?? 'running'] ?? outcome ?? 'running';

/** ONE tone table for a run and for an attempt, which carry the same outcome vocabulary. Anything else — running,
 *  canceled, not yet reported — is in-flight, so it reads as a caution rather than a verdict. */
const OUTCOME_TONES: Record<string, 'ok' | 'bad' | 'warn'> = { ready: 'ok', failed: 'bad', abandoned: 'bad' };
export const outcomeTone = (outcome: string | null): 'ok' | 'bad' | 'warn' => OUTCOME_TONES[outcome ?? ''] ?? 'warn';

/** The model/hardware keys, in words. `asrModel` and `syncMode` are field names, not English. */
const FACT_LABELS: Record<string, string> = {
	engine: 'separator',
	model: 'model',
	backend: 'runtime',
	device: 'hardware',
	threads: 'torch threads',
	asrModel: 'speech model',
	syncMode: 'timing'
};
export const factLabel = (k: string): string => FACT_LABELS[k] ?? k;

/** Label/value pairs for the model block, dropping every absent field rather than printing an empty row. */
export function modelFacts(models: Record<string, string | null>): [string, string][] {
	return Object.entries(models)
		.filter((entry): entry is [string, string] => Boolean(entry[1]))
		.map(([key, value]): [string, string] => [factLabel(key), value]);
}

/** The distinction worth keeping: `agreement` means a baseline voted, so a wrong pick there is a metric problem;
 *  `metadata` means none could and cheap ordering stood, which a better metric does not fix. */
const DECIDED_LABELS: Record<string, string> = {
	agreement: 'a baseline judged it',
	metadata: 'no baseline could judge — chosen on metadata'
};
export const decidedLabel = (d: string): string => DECIDED_LABELS[d] ?? d;

/** Two decimals, and an em dash for absent — never `0.00`, which reads as a measured zero. */
export const score = (n: number | null): string => (n === null ? '—' : n.toFixed(2));

/** `host` is an OPEN BAG, so an unexpected or absent key is skipped rather than thrown on. */
const HOST_LABELS: Record<string, string> = {
	accelerator: 'accelerator',
	deviceName: 'gpu',
	cpuCount: 'cpus',
	platform: 'platform',
	python: 'python',
	torch: 'torch',
	contained: 'contained'
};
export function hostFacts(host: Record<string, unknown>): [string, string][] {
	return labelled(HOST_LABELS, host);
}

/** The worker's resolved profile, in the same words the attempt rows use (`FACT_LABELS`). */
const PROFILE_LABELS: Record<string, string> = {
	device: 'hardware',
	backend: 'runtime',
	threads: 'torch threads',
	demucsJobs: 'demucs jobs'
};

/** One worker's fact list: what it RESOLVED first, then what it measured about the box. A resolved device
 *  hides the host's `accelerator`, which would only say the same thing again under another name. */
export function workerFacts(
	profile: Record<string, unknown> | null,
	host: Record<string, unknown> | null
): [string, string][] {
	const box = { ...host };
	if (profile?.device != null) delete box.accelerator;
	return [...labelled(PROFILE_LABELS, profile ?? {}), ...labelled(HOST_LABELS, box)];
}

function labelled(labels: Record<string, string>, bag: Record<string, unknown>): [string, string][] {
	return Object.entries(labels)
		.map(([key, label]): [string, string] => [label, bag[key] == null ? '' : String(bag[key])])
		.filter(([, value]) => value !== '');
}

/** Pick to ready as a multiple of the song's length, the way goal 2 states it ("0.62x"). */
export const times = (v: number | null): string => (v === null ? '—' : `${v.toFixed(2)}x`);

/** "of the song's own length · 2m 24s for a 3m 52s song", the headline's second line. */
export function typicalSong(multiple: number | null, audioSec: number | null): string {
	const base = "of the song's own length";
	if (multiple === null || audioSec === null) return base;
	return `${base} · ${dur(multiple * audioSec * 1000)} for a ${dur(audioSec * 1000)} song`;
}

/** Songs that reached ready but could not be timed, said rather than silently dropped. '' when there are none. */
export function unmeasured(noLength: number, badClock: number): string {
	const parts: string[] = [];
	if (noLength) parts.push(`${count(noLength, 'song')} had no known length`);
	if (badClock) parts.push(`${count(badClock, 'song')} finished before it started (the clock jumped back)`);
	return parts.length ? `Not counted: ${parts.join('; ')}.` : '';
}

const DEVICE_LABELS: Record<string, string> = { cuda: 'NVIDIA GPU', mps: 'Apple GPU', cpu: 'CPU' };

/** "Apple GPU · 10 threads"; an older row with no device says so rather than guessing. */
export function runsOn(device: string | null, threads: number | null): string {
	const parts = [device ? (DEVICE_LABELS[device] ?? device) : 'not recorded'];
	if (threads != null) parts.push(count(threads, 'thread'));
	return parts.join(' · ');
}

const CAUSE_LABELS: Record<string, string> = {
	'rate-limited': 'YouTube said too many requests',
	removed: 'Video removed or private',
	hung: 'Stopped: took far longer than usual',
	'worker-lost': 'Worker stopped answering',
	silent: 'Vocal removal came out silent',
	'out-of-memory': 'Ran out of memory',
	other: 'Something else'
};
export const causeLabel = (cause: string): string => CAUSE_LABELS[cause] ?? cause;

/** "Sat 11:48 pm" in the viewer's zone, or "Nov 12 11:48 pm" past six days, where a weekday would repeat. */
export function lastSeen(ms: number, now = Date.now(), timeZone?: string): string {
	const d = new Date(ms);
	const recent = now - ms < 6 * 86_400_000;
	const day = d.toLocaleDateString(
		'en-US',
		recent ? { weekday: 'short', timeZone } : { month: 'short', day: 'numeric', timeZone }
	);
	const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).toLowerCase();
	return `${day} ${time}`;
}

/** Which step is the bottleneck. Marked in the table because comparing mixed units down a column is arithmetic,
 *  not a glance. `null` for an empty set — there is no slowest step among none. */
export function slowestStepType(steps: readonly { jobType: string; meanMs: number | null }[]): string | null {
	if (steps.length === 0) return null;
	return steps.reduce((best, s) => ((s.meanMs ?? 0) > (best.meanMs ?? 0) ? s : best)).jobType;
}
