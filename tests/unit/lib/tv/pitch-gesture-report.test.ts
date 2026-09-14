// — a transpose that cannot route must SAY so, and a later user gesture must make it work.
//
// This is the regression test for "the semitone buttons dont work right now". The whole control chain
// was already intact — phone ± -> ws `key` -> player.ts -> `playback:state` -> the slot's `keyShift`
// prop -> `setShift` -> the worklet — and 46 pitch tests passed while the feature was dead in the
// room. Two things were wrong at the very bottom, and both are covered here:
//
//   1. NOBODY READ THE FAILURE. A browser only lets an AudioContext reach `running` once the page has
//      user activation. Without it `PitchShiftGraph` deliberately degrades — it closes the context and
//      leaves the element on its native output, audible but UNSHIFTED, because capturing the element
//      into a suspended graph would cost the room ALL audio permanently. `isDegraded`/`isRouted`
//      existed and had zero production callers, so the room got silence about it.
//   2. THE GESTURE LISTENER WAS ARMED ONLY WHEN AUTOPLAY HAD BEEN REFUSED. On a TV that autoplays
//      correctly — the normal case — there was no listener at all, so the AudioContext could never
//      become resumable and every press of ± was permanently inert.
//
// The existing pitch tests stub `AudioContext` by REPLACING `globalThis.window`, which a mounted
// component cannot survive (it needs happy-dom's real window for the DOM). Here the stub is INSTALLED
// ONTO that window instead, so the component and the graph both see what they need.
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
	// Installed ON happy-dom's window — pitch-shift.ts reads `window.AudioContext`.
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

/** Let the graph's async build settle — setShift and the retry are both promise-based. */
async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
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
	// No gesture has happened, so the context stays suspended and the graph degrades.
	const seen = { blocked: 0, routed: 0 };
	mountSlot(2, seen);
	await settle();
	expect(seen.blocked, 'the page must be told the transpose could not route').toBeGreaterThan(0);
});

test('a transpose that DOES route reports routed, not blocked', async () => {
	// The wall was already touched before the press: the context resumes and the graph routes.
	canResume = true;
	const seen = { blocked: 0, routed: 0 };
	mountSlot(2, seen);
	await settle();
	expect(seen.routed).toBeGreaterThan(0);
	expect(seen.blocked).toBe(0);
});

test('a gesture after a blocked transpose re-drives it, and it routes', async () => {
	// THE FIX, end to end. The press happens first and degrades; the wall is tapped afterwards. Before
	// this change no listener existed on a TV whose autoplay had succeeded, and none of the pitch
	// effect's tracked deps change on a tap — so the song stayed in the wrong key for ever.
	const seen = { blocked: 0, routed: 0 };
	mountSlot(2, seen);
	await settle();
	expect(seen.blocked).toBeGreaterThan(0);
	const blockedBefore = seen.blocked;

	// Somebody touches the TV. This is now a resumable context.
	canResume = true;
	win.dispatchEvent(new win.Event('pointerdown'));
	await settle();

	expect(seen.routed, 'the gesture must re-drive the pending transpose').toBeGreaterThan(0);
	// And it is not merely re-reporting the block.
	expect(seen.blocked).toBe(blockedBefore);
});

test('at keyShift 0 nothing is built and nothing is blocked — the invariant holds', async () => {
	// The load-bearing default: a song at concert pitch must touch no WebAudio at all, so a broken
	// graph can never cost the room its audio. A gesture must not build one either.
	const seen = { blocked: 0, routed: 0 };
	mountSlot(0, seen);
	await settle();
	expect(seen.blocked).toBe(0);

	win.dispatchEvent(new win.Event('pointerdown'));
	await settle();
	expect(seen.blocked).toBe(0);
});
