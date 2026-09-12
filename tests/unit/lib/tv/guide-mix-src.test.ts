// The invariant that stands between the guide mix and the two worst outcomes in the feature:
//
//   1. a 4-channel file must NEVER reach an element that is not routed through a RUNNING, SPLIT graph
//      (a native downmix sums the isolated vocals into the instrumental at full volume), and
//   2. the src must be decided ONCE — a second decision rewrites `src` on a playing element, and the
//      media load algorithm then parks the master at 0 for the rest of the song with nothing to restart it.
//
// Every case below is written from those two directions. The `pending` and `denied` assertions are the
// interesting ones; `routed` is the easy half.
import { test, expect, describe } from 'bun:test';
import type { GuidePath } from '$lib/contract';
import { masterSrcPlan, wantsEagerGraph, mixGateFor, type MixGate } from '$lib/tv/guide-mix-src';

const INST = 'derived/stems/m1-instrumental.flac';
const MIX = 'derived/stems/m1-guidemix.flac';

const mix: GuidePath = { kind: 'mix', ref: MIX };
const element: GuidePath = { kind: 'element', ref: 'derived/stems/m1-vocals.flac' };
const none: GuidePath = { kind: 'none' };
const GATES: MixGate[] = ['pending', 'routed', 'denied'];

describe('the src is decided ONCE — nothing is committed while the attempt is pending', () => {
	test('pending commits NO src, so there is nothing to rewrite later', () => {
		// The whole point: an empty ref means `nextVideoSrc` reports no change, `hasSrc` stays false, the
		// transport stays `idle`, and no play() is ever issued against a src that is about to be replaced.
		expect(masterSrcPlan(mix, INST, 'pending')).toEqual({ ref: '', mixed: false });
	});

	test('pending does NOT fall back to the instrumental — that IS the double decision', () => {
		// Committing the instrumental here is what the first implementation did, and it is why the master
		// ended up parked at 0: the mix then had to be assigned over it on a playing element.
		expect(masterSrcPlan(mix, INST, 'pending').ref).not.toBe(INST);
	});

	test('a NON-mix song ignores the gate entirely and plays immediately', () => {
		// No waiting for a graph that will never be built: today's behaviour, byte for byte.
		for (const gate of GATES) {
			expect(masterSrcPlan(element, INST, gate)).toEqual({ ref: INST, mixed: false });
			expect(masterSrcPlan(none, INST, gate)).toEqual({ ref: INST, mixed: false });
		}
	});
});

describe('only a routed SPLIT graph may be handed the 4-channel file', () => {
	test('routed: the mix plays', () => {
		expect(masterSrcPlan(mix, INST, 'routed')).toEqual({ ref: MIX, mixed: true });
	});

	test('denied: the plain instrumental plays — the room loses the GUIDE, not the song', () => {
		expect(masterSrcPlan(mix, INST, 'denied')).toEqual({ ref: INST, mixed: false });
	});

	test('`mixed` is true ONLY for a routed mix — the flag and the file cannot disagree', () => {
		for (const gate of GATES) {
			for (const p of [element, none]) expect(masterSrcPlan(p, INST, gate).mixed).toBe(false);
		}
		expect(masterSrcPlan(mix, INST, 'pending').mixed).toBe(false);
		expect(masterSrcPlan(mix, INST, 'denied').mixed).toBe(false);
		expect(masterSrcPlan(mix, INST, 'routed').mixed).toBe(true);
	});

	test('nothing playable yields an empty src on every gate', () => {
		for (const gate of GATES) {
			expect(masterSrcPlan(mix, '', gate)).toEqual({ ref: '', mixed: false });
			expect(masterSrcPlan(element, '', gate)).toEqual({ ref: '', mixed: false });
		}
	});
});

describe('mixGateFor — routed AND split, because either alone is a downmix', () => {
	const g = (isRouted: boolean, isSplit: boolean) => ({ isRouted, isSplit });

	test('a routed split graph is the only `routed` answer', () => {
		expect(mixGateFor(g(true, true), true)).toBe('routed');
	});

	test('a routed NON-SPLIT graph is DENIED — the leftover-transpose-graph defect', () => {
		// Reachable with no race: transpose a normal song (builds a non-split graph, permanently captured),
		// then let a mix song land in that slot. Asking `isRouted` alone hands the 4-channel file to a
		// stereo graph, and the destination downmixes it — vocals summed in at -6 dB, guide knob dead.
		expect(mixGateFor(g(true, false), true)).toBe('denied');
	});

	test('a split graph that never routed is DENIED', () => {
		// A suspended context on a TV wall that never received a gesture.
		expect(mixGateFor(g(false, true), true)).toBe('denied');
	});

	test('no graph at all is DENIED, never routed', () => {
		expect(mixGateFor(undefined, true)).toBe('denied');
	});

	test('an unsettled attempt is PENDING whatever the graph currently reports', () => {
		// Load-bearing: mid-build the graph can already report routed-and-split for a PRIOR song, and
		// reading it then is how the wrong src gets committed.
		expect(mixGateFor(g(true, true), false)).toBe('pending');
		expect(mixGateFor(g(false, false), false)).toBe('pending');
		expect(mixGateFor(undefined, false)).toBe('pending');
	});
});

describe('when to attempt the graph at all', () => {
	test('a mix song wants it eagerly — its guide does not exist until the splitter runs', () => {
		expect(wantsEagerGraph(mix)).toBe(true);
	});

	test('every other song keeps the LAZY graph, so keyShift 0 stays the plain element path', () => {
		expect(wantsEagerGraph(element)).toBe(false);
		expect(wantsEagerGraph(none)).toBe(false);
	});
});
