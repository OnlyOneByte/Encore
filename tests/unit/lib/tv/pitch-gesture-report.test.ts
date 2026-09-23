// A transpose that cannot route must SAY so, and a later user gesture must make it work. The whole control
// chain can be intact — phone ± → ws `key` → player.ts → `playback:state` → the slot's `keyShift` prop →
// `setShift` → the worklet — while the feature is dead in the room, for two reasons at the bottom of it:
//
//   1. NOBODY READS THE FAILURE. A browser only lets an AudioContext reach `running` once the page has user
//      activation, and without it `PitchShiftGraph` deliberately degrades: it closes the context and leaves
//      the element audible but UNSHIFTED, because capturing it into a suspended graph would cost the room
//      ALL audio permanently. `isDegraded`/`isRouted` with no production caller means silence about that.
//   2. THE GESTURE LISTENER MUST NOT BE ARMED ONLY WHEN AUTOPLAY WAS REFUSED. On a TV that autoplays
//      correctly there is then no listener at all, so the context never becomes resumable and every ± press
//      is permanently inert.
//
// The stub is INSTALLED ONTO happy-dom's window rather than replacing `globalThis.window`, which a mounted
// component cannot survive.
import { test, expect, afterEach, beforeEach } from 'bun:test';
import { mount, unmount, flushSync } from '$setup/svelte-client';
import TvPlayer from '$lib/tv/TvPlayer.svelte';
import { makeReactive } from './playback-common-actions.harness.svelte.js';

const win = (globalThis as unknown as { window: Window & typeof globalThis }).window;
const g = globalThis as unknown as Record<string, unknown>;

// resume() reaches `running` iff this is set when the context is created — the TV wall being touched.
let canResume = false;

class StubNode {
	port = { postMessage: (_m: unknown) => {} };
	connect(dest: unknown) {
		return dest as StubNode;
	}
	disconnect() {}
}
class StubGain extends StubNode {
	gain = { value: 1 };
}
class StubAudioContext {
	state: 'suspended' | 'running' | 'closed' = 'suspended';
	destination = new StubNode();
	async resume() {
		if (canResume) this.state = 'running';
	}
	async close() {
		this.state = 'closed';
	}
	createMediaElementSource(_el: unknown) {
		return new StubNode() as unknown as MediaElementAudioSourceNode;
	}
	createGain() {
		return new StubGain() as unknown as GainNode;
	}
	audioWorklet = { addModule: async (_url: string) => {} };
}

let saved: Record<string, unknown> = {};
beforeEach(() => {
	canResume = false;
	saved = {
		AudioContext: (win as unknown as Record<string, unknown>).AudioContext,
		AudioWorkletNode: g.AudioWorkletNode,
		Blob: g.Blob,
		URL: g.URL
	};
	// Installed ON happy-dom's window, because pitch-shift.ts reads `window.AudioContext`.
	(win as unknown as Record<string, unknown>).AudioContext = StubAudioContext;
	g.AudioWorkletNode = StubNode;
	g.Blob = class {
		constructor(
			public parts: unknown[],
			public opts: unknown
		) {}
	};
	g.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };
});

let live: Array<{ comp: unknown; host: HTMLElement }> = [];
afterEach(() => {
	for (const { comp, host } of live) {
		void unmount(comp as never);
		host.remove();
	}
	live = [];
	(win as unknown as Record<string, unknown>).AudioContext = saved.AudioContext;
	g.AudioWorkletNode = saved.AudioWorkletNode;
	g.Blob = saved.Blob;
	g.URL = saved.URL;
});

const SNAP = {
	id: 'm1',
	title: 'Sweet Caroline',
	artist: 'Neil Diamond',
	instrumentalRef: 'audio/sweet.wav',
	stemStatus: 'ready',
	__snapshot: true
} as unknown as Record<string, unknown>;

/**
 * Let the graph's async build settle. MACROTASK turns, never a count of microtasks: draining N
 * `await Promise.resolve()` bets on the exact LENGTH of an await chain in production code, and the routed
 * and DEGRADED paths are different lengths — so a shortfall reds the blocked-path tests and reports a
 * product defect that is really a defect in this helper. A `setTimeout(0)` runs only once the microtask
 * queue is fully drained, so this covers any chain length.
 */
async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
}

function mountSlot(keyShift: number, seen: { blocked: number; routed: number }): { props: Record<string, unknown> } {
	const props = makeReactive({
		media: SNAP,
		entryId: 'e1',
		visible: true,
		active: true,
		playing: true,
		keyShift,
		onpitchblocked: () => (seen.blocked += 1),
		onpitchrouted: () => (seen.routed += 1)
	}) as Record<string, unknown>;
	const host = document.createElement('div');
	document.body.appendChild(host);
	const comp = mount(TvPlayer as never, { target: host, props });
	flushSync();
	live.push({ comp, host });
	return { props };
}

test('a transpose that cannot route REPORTS it, instead of failing silently', async () => {
	const seen = { blocked: 0, routed: 0 };
	mountSlot(2, seen);
	await settle();
	expect(seen.blocked, 'the page must be told the transpose could not route').toBeGreaterThan(0);
});

test('a transpose that DOES route reports routed, not blocked', async () => {
	// The wall was touched before the press, so the context resumes and the graph routes.
	canResume = true;
	const seen = { blocked: 0, routed: 0 };
	mountSlot(2, seen);
	await settle();
	expect(seen.routed).toBeGreaterThan(0);
	expect(seen.blocked).toBe(0);
});

test('a gesture after a blocked transpose re-drives it, and it routes', async () => {
	// End to end: the press degrades, then the wall is tapped. None of the pitch effect's tracked deps
	// change on a tap, so without a listener on an autoplaying TV the song stays in the wrong key forever.
	const seen = { blocked: 0, routed: 0 };
	mountSlot(2, seen);
	await settle();
	expect(seen.blocked).toBeGreaterThan(0);
	const blockedBefore = seen.blocked;

	canResume = true;
	win.dispatchEvent(new win.Event('pointerdown'));
	await settle();

	expect(seen.routed, 'the gesture must re-drive the pending transpose').toBeGreaterThan(0);
	expect(seen.blocked).toBe(blockedBefore);
});

test('at keyShift 0 nothing is built and nothing is blocked — the invariant holds', async () => {
	// A song at concert pitch must touch no WebAudio at all, so a broken graph can never cost the room its
	// audio — and a gesture must not build one either.
	const seen = { blocked: 0, routed: 0 };
	mountSlot(0, seen);
	await settle();
	expect(seen.blocked).toBe(0);

	win.dispatchEvent(new win.Event('pointerdown'));
	await settle();
	expect(seen.blocked).toBe(0);
});
