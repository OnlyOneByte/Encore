// Regression guard for the SILENT-AUDIO-AFTER-A-COMMON-ACTION class — the prevention split
// out of the skip-silence fix. The same defect has shipped three times on the same two media elements, each caught
// by a human at a party rather than a test:
//
//   | Defect                | Element      | Symptom                                                              |
//   |-----------------------|--------------|----------------------------------------------------------------------|
//   | song-change silence   | instrumental | SILENT after a song change until a tone press rebuilt the graph      |
//   | transpose full-volume | guide        | jumped to FULL VOLUME after a transpose, ignoring the room level     |
//   | skip silence          | guide        | SILENT after a skipped song until a tone press                       |
//
// All three are one shape: an audio graph whose lifetime was modelled on the wrong thing, and no test
// that drove a real ACTION SEQUENCE. Every one needed TWO actions in order (set level THEN transpose;
// play THEN change song; skip THEN listen), so single-action tests caught none of them. The existing
// guards (pitch-shift-graph-lifetime.test.ts, guide-gain-after-transpose.test.ts) are per-issue
// mutation traps written after the fact plus a source scan of TvPlayer.svelte — a source scan proves a
// line is PRESENT, not that the audio is audible, which is exactly how skip silence shipped next
// door to song-change silence.
//
// This is the decision-B version (issue comment): it actually MOUNTS TvPlayer.svelte and RUNS its
// $effects, under a compiled-Svelte + happy-dom harness (tests/setup/, wired by the root bunfig.toml)
// and the same stubbed WebAudio the two guards above already use — no audio hardware, no browser, one
// `bun test` gate. It drives the action set the issue names and, after EVERY step, checks the two
// invariants the whole class reduces to, for BOTH elements:
//
//   INV-1 (audible): the element reaches a live output. On the NATIVE path that is "not paused". Once
//          a transpose ROUTES it through WebAudio, `HTMLMediaElement.volume` is bypassed, so audibility
//          is "the graph is routed to a running context and NOT degraded, wired through to the
//          destination, and its GainNode is non-zero" — a routed-but-disconnected graph is the
//          song-change-silence / skip-silence defect.
//   INV-2 (gain): the level the room last set is the level actually applied — the element's `.volume`
//          on the native path, the GainNode's `gain.value` once routed. A routed GainNode stuck at the
//          default 1 while the room asked for less is the transpose full-volume defect.
//
// The biting-mutation proof (each of the three old bugs reintroduced into a TvPlayer copy reds this
// matrix) is in the PR body; the guards for "which source line" remain the two files above.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import type { ComponentProps } from 'svelte';
import { mount, flushSync } from '$setup/svelte-client';
import TvPlayer from '$lib/tv/TvPlayer.svelte';
import type { PlaybackSnapshot } from '$lib/tv/catalog';
import { makeReactive } from './playback-common-actions.harness.svelte';

// ── stubbed WebAudio (same technique as guide-gain-after-transpose.test.ts) ──────────────────────
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

// ── a song, and a controllable player ────────────────────────────────────────────────────────────
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

// A mounted TvPlayer we can drive. Reactive props live in a rune module (harness) so a test file
// (a plain .ts) can mutate them and have the component's effects re-run — runes are illegal in .ts.
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

// ── the two invariants, read off the live component + the stub graph ────────────────────────────
// The component holds its PitchShiftGraphs privately, so once an element is routed we read its state
// off the stub context the graph built (source -> node -> gain -> destination). Before any transpose
// there is no graph and the element's own paused/volume govern.
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
		// Native path: audible == mounted and not paused; the level applied is the element's volume.
		const paused = el ? el.paused : true;
		const vol = el ? el.volume : 0;
		return { routed: false, audible: !!el && !paused, gain: vol };
	}
	// Routed path: HTMLMediaElement.volume is bypassed. The last GainNode carries the audible level;
	// audibility needs a running context and a gain node still wired through to the destination (a
	// detach()ed graph on a still-captured element disconnects that chain — the silence bug).
	const gainNode = ctx.gains[ctx.gains.length - 1];
	const running = ctx.state === 'running' && !ctx.closed;
	const reachesDest = ctx.gains.some((gn) => gn.connections.includes(ctx.destination));
	return { routed: true, audible: running && reachesDest, gain: gainNode ? gainNode.gain.value : 0 };
}

// ── the matrix ───────────────────────────────────────────────────────────────────────────────────
test('matrix: instrumental + guide stay audible and correctly gained across common room actions', async () => {
	const g2 = song('2');
	const { props, audios } = makePlayer({ media: song('1'), guideLevel: 0.5 });
	await settle();

	const master = () => audios()[0];
	const guide = () => audios()[1];

	async function assertInvariants(where: string, playing: boolean, level: number) {
		const m = readEl(master());
		const gd = readEl(guide());
		// INV-1 master: playing => reaching output; paused => paused.
		if (playing) expect(m.audible, `${where}: master audible`).toBe(true);
		else expect(m.audible, `${where}: master paused`).toBe(false);
		if (guide()) {
			// INV-1 guide: audible whenever the room wants it (> 0) and is playing. A level of 0 is
			// legitimately silent, not a regression.
			if (playing && level > 0) expect(gd.audible, `${where}: guide audible`).toBe(true);
			// INV-2 guide: the level actually applied equals the room level, on EITHER path. Once routed
			// this is the transpose full-volume assertion — a routed GainNode must not sit at the default 1.
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

	// Transpose up — routes BOTH elements. The guide must land at .5, not the default 1.
	props.keyShift = 3;
	await settle();
	await assertInvariants('after transpose up (routed)', true, 0.5);

	// Guide level change while routed — the routed GainNode must follow the knob.
	props.guideLevel = 0.2;
	await settle();
	await assertInvariants('after guide level change while routed', true, 0.2);

	// Transpose back to 0 — the graph stays (ratio 1), still audible, still at the room level.
	props.keyShift = 0;
	await settle();
	await assertInvariants('after transpose back to 0', true, 0.2);

	// SONG CHANGE in place (a skip: same slot, new song). Master and guide alike: the per-song
	// reset must keep both routed graphs ALIVE (setShift(0), re-apply gain), NOT detach them.
	props.media = g2;
	props.entryId = 'e2';
	await settle();
	await assertInvariants('after song change (skip in place)', true, 0.2);

	// Raise the guide again after the change — still tracks.
	props.guideLevel = 0.7;
	await settle();
	await assertInvariants('after guide raise post-change', true, 0.7);

	// Restart (a seek to 0 via a rev bump) — audio unaffected.
	props.seekSec = 0;
	props.seekRev = (props.seekRev as number) + 1;
	await settle();
	await assertInvariants('after restart', true, 0.7);
});
