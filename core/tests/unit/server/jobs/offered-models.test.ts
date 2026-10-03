// The union of what connected workers say they can separate with.
//
// Pure over sessions, so a mixed fleet is expressible in three lines — which matters, because the
// interesting behaviour here is all about disagreement between workers.

import type { SeparatorOffer } from '$lib/contract';
import { isOffered, offeredModels } from '$lib/server/jobs/offered-models';
import type { WorkerSession } from '$lib/server/jobs/registry';
import { expect, test } from 'bun:test';

function worker(workerId: string, separators?: SeparatorOffer[]): WorkerSession {
	return {
		workerId,
		capabilities: ['stems'],
		concurrency: 1,
		version: '1',
		slotsFree: 1,
		lastSeen: 0,
		...(separators ? { separators } : {})
	};
}

const offer = (token: string, over: Partial<SeparatorOffer> = {}): SeparatorOffer => ({
	token,
	label: token,
	architecture: 'MDXC',
	...over
});

test('a fleet with no catalogue yet offers nothing, rather than throwing', () => {
	// `separators` is absent for the seconds between a worker joining and its catalogue landing, and forever
	// on a worker without the extra. Neither is an error.
	expect(offeredModels([worker('w1'), worker('w2')])).toEqual([]);
});

test('models from different workers are UNIONED, not intersected', () => {
	// A mixed fleet is the normal case: one box with the zoo installed, one without. An intersection would
	// empty the picker the moment a plain worker connected — a menu that shrinks for invisible reasons.
	const got = offeredModels([worker('zoo', [offer('a'), offer('b')]), worker('plain')]);
	expect(got.map((m) => m.token)).toEqual(['a', 'b']);
});

test('a model two workers offer is listed once, with the count', () => {
	const got = offeredModels([worker('w1', [offer('a')]), worker('w2', [offer('a')])]);
	expect(got).toHaveLength(1);
	expect(got[0]!.workerCount).toBe(2);
});

test('workerCount of 1 is what lets a picker warn that a pick pins the job to one box', () => {
	const got = offeredModels([
		worker('w1', [offer('only-here')]),
		worker('w2', [offer('shared')]),
		worker('w3', [offer('shared')])
	]);
	expect(got.find((m) => m.token === 'only-here')!.workerCount).toBe(1);
	expect(got.find((m) => m.token === 'shared')!.workerCount).toBe(2);
});

test('ranked by upstream score, unscored last', () => {
	// The order IS the recommendation: an operator browsing 130+ models needs the list to mean something
	// before they have measured any of them.
	const got = offeredModels([
		worker('w1', [
			offer('mid', { upstreamInstrumentalSdr: 14 }),
			offer('unscored'),
			offer('best', { upstreamInstrumentalSdr: 17 })
		])
	]);
	expect(got.map((m) => m.token)).toEqual(['best', 'mid', 'unscored']);
});

test('a score on one worker fills a gap left by another, whatever the order', () => {
	// Two workers on different audio-separator versions can describe the same checkpoint with and without a
	// score. Dropping the scored one would make the list look emptier than it is.
	const scored = worker('w1', [offer('a', { upstreamInstrumentalSdr: 16 })]);
	const bare = worker('w2', [offer('a')]);
	for (const fleet of [
		[scored, bare],
		[bare, scored]
	]) {
		const got = offeredModels(fleet);
		expect(got).toHaveLength(1);
		expect(got[0]!.upstreamInstrumentalSdr).toBe(16);
	}
});

test('an offer with no token is skipped rather than listed unusably', () => {
	// The token is what a job names. A blank one could not be selected or routed, so it must not reach a
	// picker — the hub's validation refuses these, and this is the second line of defence.
	const got = offeredModels([worker('w1', [offer(''), offer('real')])]);
	expect(got.map((m) => m.token)).toEqual(['real']);
});

test('isOffered answers whether a saved setting is currently runnable', () => {
	// A stale `upgradeModel` is not an error — the worker may reconnect — but it is worth surfacing, because
	// otherwise a queued upgrade sits unservable with nothing on screen explaining why.
	const fleet = [worker('w1', [offer('present')])];
	expect(isOffered('present', fleet)).toBe(true);
	expect(isOffered('departed', fleet)).toBe(false);
	expect(isOffered('present', [worker('w1')])).toBe(false);
});
