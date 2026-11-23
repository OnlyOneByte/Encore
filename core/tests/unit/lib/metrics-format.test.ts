// The operator metrics formatters. `dur` must round BEFORE splitting into units: rounding after prints
// 119_600ms as "1m 60s" and 59_960ms as "60.0s", neither of which is a time.
import { test, expect } from 'bun:test';
import { dur, stepLabel, stageLabel, lastSeen, localStamp, pct, runsOn, times, vsClaimed } from '$lib/metrics-format';

test('the speed page says multiples, machines and "when" in words', () => {
	expect(times(0.6249)).toBe('0.62x');
	expect(times(null)).toBe('—');
	expect(runsOn('mps', 10)).toBe('Apple GPU · 10 threads');
	expect(runsOn(null, null)).toBe('not recorded');
	const sat = Date.UTC(2026, 10, 21, 23, 48); // Sat Nov 21, 11:48 pm UTC
	expect(lastSeen(sat, sat + 86_400_000, 'UTC')).toBe('Sat 11:48 pm');
	expect(lastSeen(sat, sat + 9 * 86_400_000, 'UTC')).toBe('Nov 21 11:48 pm');
});

test('a rate reads as a percentage of the song, and an unmeasured one is not 0%', () => {
	// The percent form needs no caption: 15% of the song's length.
	expect(pct(0.15)).toBe('15%');
	expect(pct(1.62)).toBe('162%');
	// "never measured" and "instant" are different facts and must not render the same.
	expect(pct(null)).toBe('—');
});

test('a measured-vs-claimed rate names its own direction, so colour is not the only signal', () => {
	expect(vsClaimed(1.74)).toBe('74% slower');
	expect(vsClaimed(0.49)).toBe('51% faster');
	expect(vsClaimed(1)).toBe('matches');
	expect(vsClaimed(1.002)).toBe('matches');
	expect(vsClaimed(null)).toBe('—');
});

test('a missing timing is not zero', () => {
	// "not recorded" and "took no time" are different facts and must not render the same.
	expect(dur(null)).toBe('—');
});

test('durations never carry into a unit they do not print', () => {
	// The two carry cases, pinned by value.
	expect(dur(119_600)).toBe('2m 0s'); // was "1m 60s"
	expect(dur(59_960)).toBe('1m 0s'); // was "60.0s"

	// The boundary either side of each carry, so a "simplification" that reintroduces the off-by-one is
	// caught rather than only the two values above.
	expect(dur(59_940)).toBe('59.9s');
	expect(dur(60_000)).toBe('1m 0s');
	expect(dur(119_400)).toBe('1m 59s');
	expect(dur(120_000)).toBe('2m 0s');

	// The minute→hour carry, same rule one unit up: 3_599_700ms is 59.995 minutes, which rounds to the 60 that IS an
	// hour, so it must read "1h 0m" and never "0h 60m".
	expect(dur(3_599_700)).toBe('1h 0m');
	// The boundary either side. 59.5 minutes rounds UP to 60 and so belongs to the hour branch — the same way 59_960ms
	// already renders "1m 0s" rather than "60.0s".
	expect(dur(3_569_999)).toBe('59m 30s');
	expect(dur(3_570_000)).toBe('1h 0m');
});

test('each branch prints its own unit', () => {
	expect(dur(0)).toBe('0ms');
	expect(dur(999)).toBe('999ms');
	expect(dur(1000)).toBe('1.0s');
	expect(dur(9040)).toBe('9.0s');
	expect(dur(154_000)).toBe('2m 34s');
	// A real overnight re-process out of the copy DB's job_attempts ledger: 19h 58m 36s. Without the hour branch this
	// printed "1198m 36s", a span the reader had to divide by 60 to understand.
	expect(dur(71_916_066)).toBe('19h 59m');
});

test('an unmapped job type or stage falls through to its raw name', () => {
	// The fallthrough exists so a newly added job type shows something imperfect rather than vanishing
	// from the operator's view.
	expect(stepLabel('stems')).toBe('remove vocals');
	expect(stepLabel('brand-new-job')).toBe('brand-new-job');
	expect(stageLabel('separating')).toBe('removing vocals');
	expect(stageLabel('brand-new-stage')).toBe('brand-new-stage');
});

// `localStamp` exists because `toISOString()` with the `Z` sliced off is UTC with nothing saying so: west
// of Greenwich the time is wrong, and for a US evening party anything after 19:00 local rolls the printed
// DATE to the next day. The instant below is 21:47:03 local on a Saturday in America/Chicago.
const CHICAGO_EVENING = Date.parse('2026-09-06T02:47:03Z'); // == 21:47:03 CDT on 2026-09-05

test('localStamp renders an evening US instant on the correct LOCAL date, not the next day', () => {
	// The UTC form prints "2026-09-06 02:47:03" for this instant, dating a Saturday-evening run to Sunday.
	expect(localStamp(CHICAGO_EVENING, 'America/Chicago')).toBe('2026-09-05 21:47:03');
	// And it is NOT the UTC rendering.
	expect(localStamp(CHICAGO_EVENING, 'America/Chicago')).not.toBe('2026-09-06 02:47:03');
});

test('localStamp is a pure function of instant + zone (same instant, different viewers)', () => {
	// One instant from three zones: the offset moves the time and, across midnight, the date.
	expect(localStamp(CHICAGO_EVENING, 'UTC')).toBe('2026-09-06 02:47:03');
	expect(localStamp(CHICAGO_EVENING, 'America/Chicago')).toBe('2026-09-05 21:47:03');
	expect(localStamp(CHICAGO_EVENING, 'Australia/Sydney')).toBe('2026-09-06 12:47:03');
});

test('localStamp holds the YYYY-MM-DD HH:MM:SS shape with zero-padding and 24h midnight', () => {
	// 05:15:30 UTC is 00:15:30 in Chicago, so the hour must read "00" and not Intl's "24".
	expect(localStamp(Date.parse('2026-09-06T05:15:30Z'), 'America/Chicago')).toBe('2026-09-06 00:15:30');
	// Single-digit month/day/hour stay zero-padded, so the string sorts and aligns.
	expect(localStamp(Date.parse('2026-03-07T14:09:04Z'), 'UTC')).toBe('2026-03-07 14:09:04');
});

// ── the audit/attempt vocabulary ─────────────────────────────────────────────
// These lived in `routes/metrics/[mediaId]/+page.svelte` and `routes/metrics/+page.svelte`, where no test could
// reach them — the exact failure this module's header names. Tested here now that they are importable.
import {
	decidedLabel,
	factLabel,
	hostFacts,
	modelFacts,
	outcomeLabel,
	outcomeTone,
	score,
	slowestStepType
} from '$lib/metrics-format';

test('an unknown outcome reads as running rather than blank — an in-flight row IS running', () => {
	expect(outcomeLabel('ready')).toBe('done');
	expect(outcomeLabel('abandoned')).toBe('gave up, retried');
	expect(outcomeLabel(null)).toBe('running');
	// A value the server grew that this map has not learned: shown verbatim, never as an empty cell.
	expect(outcomeLabel('quarantined')).toBe('quarantined');
});

test('only a finished verdict gets a verdict tone; everything in flight is a caution', () => {
	expect(outcomeTone('ready')).toBe('ok');
	expect(outcomeTone('failed')).toBe('bad');
	expect(outcomeTone('abandoned')).toBe('bad');
	for (const inFlight of ['running', 'canceled', null, 'something-new']) expect(outcomeTone(inFlight)).toBe('warn');
});

test('fact labels turn field names into English, and pass through what they do not know', () => {
	expect(factLabel('asrModel')).toBe('speech model');
	expect(factLabel('syncMode')).toBe('timing');
	expect(factLabel('someNewField')).toBe('someNewField');
});

test('modelFacts drops absent fields rather than printing an empty row', () => {
	expect(modelFacts({ engine: 'demucs', model: null, device: 'cuda' })).toEqual([
		['separator', 'demucs'],
		['hardware', 'cuda']
	]);
	expect(modelFacts({})).toEqual([]);
});

test('hostFacts skips unknown and absent keys — `host` is an open bag', () => {
	expect(hostFacts({ cpuCount: 8, platform: 'linux', somethingElse: 'ignored', torch: null })).toEqual([
		['cpus', '8'],
		['platform', 'linux']
	]);
	// A present-but-falsy value is NOT absent: 0 cpus is a reading, and dropping it would read as unmeasured.
	expect(hostFacts({ cpuCount: 0 })).toEqual([['cpus', '0']]);
});

test('decidedLabel distinguishes a judged pick from one that fell through to metadata', () => {
	expect(decidedLabel('agreement')).toBe('a baseline judged it');
	expect(decidedLabel('metadata')).toBe('no baseline could judge — chosen on metadata');
	expect(decidedLabel('unknown')).toBe('unknown');
});

test('score prints an em dash for absent, never 0.00 — which would read as a measured zero', () => {
	expect(score(null)).toBe('—');
	expect(score(0)).toBe('0.00');
	expect(score(0.8166)).toBe('0.82');
});

test('slowestStepType finds the bottleneck, treats a null mean as zero, and has none among none', () => {
	expect(slowestStepType([])).toBe(null);
	expect(
		slowestStepType([
			{ jobType: 'fetch', meanMs: 400 },
			{ jobType: 'stems', meanMs: 90_000 },
			{ jobType: 'align', meanMs: 12_000 }
		])
	).toBe('stems');
	// An unreported mean must not win the comparison by being null.
	expect(
		slowestStepType([
			{ jobType: 'fetch', meanMs: null },
			{ jobType: 'stems', meanMs: 5 }
		])
	).toBe('stems');
});
