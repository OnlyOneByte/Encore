// SILENT AUDIO AFTER A COMMON ACTION — the class, not one instance. Three defects on the same two media elements
// (song-change silence on the instrumental, full-volume guide after a transpose, silence on the guide after a skip) are
// one shape: an audio graph whose lifetime was modelled on the wrong thing. Each needed TWO actions IN ORDER — set level
// then transpose, play then change song, skip then listen — so no single-action test catches any of them, and a source
// scan proves a line is PRESENT rather than that the audio is audible. So this MOUNTS TvPlayer.svelte and runs its
// $effects under the compiled-Svelte + happy-dom harness with stubbed WebAudio, checking both invariants for BOTH
// elements after EVERY step:
//
// INV-1 (audible): the element reaches a live output. On the NATIVE path that is "not paused". Once a transpose ROUTES it
// through WebAudio, `HTMLMediaElement.volume` is bypassed, so audibility becomes "routed to a running context, not
// degraded, still wired to the destination, gain non-zero" — a routed-but-disconnected graph is the silence defect.
// INV-2 (gain): the level the room last set is the level applied — `.volume` natively, the GainNode's `gain.value` once
// routed. A routed GainNode stuck at the default 1 is the full-volume defect.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import type { ComponentProps } from 'svelte';
import { mount, flushSync } from '$setup/svelte-client';
import TvPlayer from '$lib/tv/TvPlayer.svelte';
import type { PlaybackSnapshot } from '$lib/tv/catalog';
import { makeReactive } from './playback-common-actions.harness.svelte';

// Stubbed WebAudio.
class StubNode {
	connections: StubNode[] = [];
	port = { postMessage: (_m: unknown) => {} };
	connect(dest: StubNode) {
		this.connections.push(dest);
		return dest;
	}
	disconnect() {
		this.connections = [];
	}
}
class StubGain extends StubNode {
	gain = { value: 1 };
}
class StubSource extends StubNode {
	constructor(public el: unknown) {
		super();
	}
}
class StubAudioContext {
	state: 'suspended' | 'running' | 'closed' = 'running';
	destination = new StubNode();
	sources: StubSource[] = [];
	gains: StubGain[] = [];
	closed = false;
	async resume() {
		this.state = 'running';
	}
	async close() {
		this.state = 'closed';
		this.closed = true;
	}
	createMediaElementSource(el: unknown) {
		const s = new StubSource(el);
		this.sources.push(s);
		return s as unknown as MediaElementAudioSourceNode;
	}
	createGain() {
		const gn = new StubGain();
		this.gains.push(gn);
		return gn as unknown as GainNode;
	}
	audioWorklet = { addModule: async (_url: string) => {} };
}

const G = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown> = {};
// Every AudioContext the component builds this test (lazily, on the first non-zero shift per element).
let CTX: StubAudioContext[] = [];

beforeEach(() => {
	saved = {
		AudioContext: (G.window as Record<string, unknown>).AudioContext,
		AudioWorkletNode: G.AudioWorkletNode,
		Blob: G.Blob,
		URL: G.URL
	};
	CTX = [];
	const Tracked = class extends StubAudioContext {
		constructor() {
			super();
			CTX.push(this as unknown as StubAudioContext);
		}
	};
	(G.window as Record<string, unknown>).AudioContext = Tracked;
	G.AudioWorkletNode = StubNode;
	G.Blob = class {
		constructor(
			public parts: unknown[],
			public opts: unknown
		) {}
	};
	G.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };
});

afterEach(() => {
	(G.window as Record<string, unknown>).AudioContext = saved.AudioContext;
	G.AudioWorkletNode = saved.AudioWorkletNode;
	G.Blob = saved.Blob;
	G.URL = saved.URL;
});

function song(id: string): PlaybackSnapshot {
	return {
		id,
		title: `song ${id}`,
		artist: 'A',
		stemStatus: 'ready',
		instrumentalRef: `inst-${id}.flac`,
		vocalsRef: `voc-${id}.m4a`,
		songProfile: {}
	} as unknown as PlaybackSnapshot;
}

async function settle() {
	flushSync();
	await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

// Reactive props live in a rune module, so a plain `.ts` test can mutate them and have the component's
// effects re-run: runes are illegal in a `.ts` file.
type TvProps = ComponentProps<typeof TvPlayer>;
function makePlayer(initial: Partial<TvProps>) {
	const target = document.createElement('div');
	const props = makeReactive({
		media: song('1'),
		entryId: 'e1',
		visible: true,
		active: true,
		playing: true,
		seekSec: undefined as number | undefined,
		seekRev: 0,
		keyShift: 0,
		guideLevel: 0,
		...initial
	}) as TvProps;
	const comp = mount(TvPlayer, { target, props });
	const audios = () => Array.from(target.querySelectorAll('audio')) as HTMLAudioElement[];
	return { comp, props, target, audios };
}

// The component holds its PitchShiftGraphs privately, so once an element is routed its state is read off
// the stub context the graph built (source -> node -> gain -> destination). Before any transpose there is
// no graph and the element's own paused/volume govern.
function graphForEl(el: HTMLAudioElement | undefined) {
	if (!el) return null;
	for (const c of CTX) {
		const src = c.sources.find((s) => s.el === el);
		if (src) return c;
	}
	return null;
}

interface ElState {
	routed: boolean;
	audible: boolean;
	gain: number;
}
function readEl(el: HTMLAudioElement | undefined): ElState {
	const ctx = graphForEl(el);
	if (!ctx) {
		const paused = el ? el.paused : true;
		const vol = el ? el.volume : 0;
		return { routed: false, audible: !!el && !paused, gain: vol };
	}
	// Routed path: `HTMLMediaElement.volume` is bypassed, so the last GainNode carries the audible level
	// and audibility needs a running context plus a gain node still wired to the destination — a
	// detach()ed graph on a still-captured element breaks that chain, which IS the silence bug.
	const gainNode = ctx.gains[ctx.gains.length - 1];
	const running = ctx.state === 'running' && !ctx.closed;
	const reachesDest = ctx.gains.some((gn) => gn.connections.includes(ctx.destination));
	return { routed: true, audible: running && reachesDest, gain: gainNode ? gainNode.gain.value : 0 };
}

test('matrix: instrumental + guide stay audible and correctly gained across common room actions', async () => {
	const g2 = song('2');
	const { props, audios } = makePlayer({ media: song('1'), guideLevel: 0.5 });
	await settle();

	const master = () => audios()[0];
	const guide = () => audios()[1];

	async function assertInvariants(where: string, playing: boolean, level: number) {
		const m = readEl(master());
		const gd = readEl(guide());
		if (playing) expect(m.audible, `${where}: master audible`).toBe(true);
		else expect(m.audible, `${where}: master paused`).toBe(false);
		if (guide()) {
			// A guide level of 0 is legitimately silent, not a regression.
			if (playing && level > 0) expect(gd.audible, `${where}: guide audible`).toBe(true);
			// The level applied equals the room level on EITHER path: once routed, a GainNode must not sit at the default 1.
			expect(gd.gain, `${where}: guide gain == room level`).toBeCloseTo(level, 6);
		}
	}

	await assertInvariants('start (playing, guide .5, native)', true, 0.5);

	props.playing = false;
	await settle();
	await assertInvariants('after pause', false, 0.5);

	props.playing = true;
	await settle();
	await assertInvariants('after resume', true, 0.5);

	// A transpose routes BOTH elements; the guide must land at .5, not the default 1.
	props.keyShift = 3;
	await settle();
	await assertInvariants('after transpose up (routed)', true, 0.5);

	// A level change while routed: the GainNode must follow the knob.
	props.guideLevel = 0.2;
	await settle();
	await assertInvariants('after guide level change while routed', true, 0.2);

	// Back to 0: the graph STAYS at ratio 1, still audible, still at the room level.
	props.keyShift = 0;
	await settle();
	await assertInvariants('after transpose back to 0', true, 0.2);

	// A song change in place (a skip: same slot, new song). The per-song reset must keep both routed
	// graphs ALIVE — setShift(0) and re-apply gain — never detach them.
	props.media = g2;
	props.entryId = 'e2';
	await settle();
	await assertInvariants('after song change (skip in place)', true, 0.2);

	props.guideLevel = 0.7;
	await settle();
	await assertInvariants('after guide raise post-change', true, 0.7);

	// A restart (seek to 0 via a rev bump) leaves the audio unaffected.
	props.seekSec = 0;
	props.seekRev = (props.seekRev as number) + 1;
	await settle();
	await assertInvariants('after restart', true, 0.7);
});
