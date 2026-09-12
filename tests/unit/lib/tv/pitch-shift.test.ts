import { ALIGN_SEARCH, PITCH_WORKLET_SOURCE, PitchShiftGraph, grainLookahead, needsShift, readLag, semitonesToRatio } from '$lib/tv/pitch-shift';
import { afterEach, beforeEach, expect, test } from 'bun:test';


// Pure-maths guard for the browser pitch shifter. The AUDIBLE behaviour cannot be tested here — there
// is no audio hardware and no AudioContext in bun:test — so this covers only the ratio arithmetic and
// the OLA framing/window maths, which are the parts a regression would silently get wrong.


test('semitonesToRatio: 0 is EXACTLY 1 (bit-exact bypass check)', () => {
	// The caller keys "bypass" off ratio === 1, so this must not be 0.9999999.
	expect(semitonesToRatio(0)).toBe(1);
	expect(Object.is(semitonesToRatio(0), 1)).toBe(true);
});

test('semitonesToRatio: an octave up/down is 2×/0.5×', () => {
	expect(semitonesToRatio(12)).toBeCloseTo(2, 10);
	expect(semitonesToRatio(-12)).toBeCloseTo(0.5, 10);
});

test('semitonesToRatio: a fifth up is ~1.4983 (equal temperament)', () => {
	// 7 semitones — the ±MAX_KEY_SHIFT bound.
	expect(semitonesToRatio(7)).toBeCloseTo(1.4983, 3);
	expect(semitonesToRatio(-7)).toBeCloseTo(0.6674, 3);
});

test('semitonesToRatio: non-finite falls back to 1 (never a wild transpose)', () => {
	expect(semitonesToRatio(NaN)).toBe(1);
	expect(semitonesToRatio(Infinity)).toBe(1);
	expect(semitonesToRatio(-Infinity)).toBe(1);
});

test('needsShift: only a non-unity ratio needs the graph', () => {
	expect(needsShift(0)).toBe(false);
	expect(needsShift(NaN)).toBe(false);
	expect(needsShift(1)).toBe(true);
	expect(needsShift(-1)).toBe(true);
	expect(needsShift(7)).toBe(true);
});

test('grainLookahead / readLag: the read pointer must lag the write head, and by how much', () => {
	// REPLACES a test that asserted `analysisHop(256, 2) === 512`. That formula WAS the shipped bug:
	// it is the analysis hop for a design where resampling is a separate stage after time-stretching,
	// but here the resample is fused into the grain read, so scaling the hop by ratio applied the tempo
	// correction twice and the read pointer ran away from the write pointer without bound.
	// A slow read needs LESS lookahead, not more: at ratio 0.5 a 1024-sample grain spans 512 input.
	expect(grainLookahead(1024, 1)).toBe(1024);
	expect(grainLookahead(1024, 2)).toBe(2048);
	expect(grainLookahead(1024, 0.5)).toBe(512);
	// The lag adds the alignment search and one hop, so neither a block edge nor the SOLA search can
	// read past the newest input.
	expect(readLag(1024, 256, 1)).toBe(1024 + ALIGN_SEARCH + 256);
	expect(readLag(1024, 256, 1.5)).toBe(1536 + ALIGN_SEARCH + 256);
});

// ── §1: setShift must have an in-flight guard so a double transpose builds ONE graph ──────
// The AUDIBLE path can't run in bun (no audio hardware), but the re-entrancy defect is pure control
// flow: build() reads `routed` at entry, but `routed` only flips AFTER `await ctx.resume()` and
// `await addModule(...)`. Two setShift(non-zero) calls landing in that async window (two playback:state
// broadcasts ~10ms apart from a guest double-tapping ±key) both passed the guard, so both called the
// irreversible createMediaElementSource — the second throws and strands a second AudioContext. The fix
// memoises the in-flight build() promise (#building) so concurrent callers share one attempt.
//
// We inject minimal fake WebAudio globals whose resume()/addModule() resolve on a later microtask, so
// two setShift calls genuinely interleave inside build(). We then count createMediaElementSource.
function withFakeAudio<T>(run: () => Promise<T>): Promise<T> {
	const g = globalThis as unknown as Record<string, unknown>;
	const saved: Record<string, unknown> = {};
	let sourceCreations = 0;
	let ctxCreations = 0;
	const later = () => new Promise<void>((r) => setTimeout(r, 0)); // defer past the current microtask run
	class FakeCtx {
		state = 'suspended';
		destination = {};
		audioWorklet = {
			addModule: async () => {
				await later();
			}
		};
		constructor() {
			ctxCreations++;
		}
		async resume() {
			await later();
			this.state = 'running';
		}
		async close() {
			this.state = 'closed';
		}
		createMediaElementSource() {
			sourceCreations++;
			// mirror the platform: a second capture of the same element throws
			if (sourceCreations > 1) throw new DOMException('already connected', 'InvalidStateError');
			return { connect: (n: unknown) => n } as unknown;
		}
		createGain() {
			return { gain: { value: 1 }, connect: (n: unknown) => n } as unknown;
		}
	}
	for (const [k, v] of Object.entries({
		window: { AudioContext: FakeCtx },
		AudioContext: FakeCtx,
		AudioWorkletNode: class {
			port = { postMessage() {} };
			connect(n: unknown) {
				return n;
			}
		},
		Blob: class {
			constructor(_: unknown[]) {}
		},
		URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
		DOMException:
			(globalThis as unknown as { DOMException?: unknown }).DOMException ??
			class extends Error {
				constructor(
					m: string,
					public name2 = 'Error'
				) {
					super(m);
				}
			}
	})) {
		saved[k] = g[k];
		g[k] = v;
	}
	// expose the counters for the assertion
	(g as Record<string, unknown>).__counts = {
		get source() {
			return sourceCreations;
		},
		get ctx() {
			return ctxCreations;
		}
	};
	return run().finally(() => {
		for (const k of Object.keys(saved)) {
			if (saved[k] === undefined) delete g[k];
			else g[k] = saved[k];
		}
		delete (g as Record<string, unknown>).__counts;
	});
}

test('two concurrent setShift(non-zero) calls build the graph ONCE (no double createMediaElementSource)', async () => {
	await withFakeAudio(async () => {
		const el = {} as HTMLMediaElement;
		const graph = new PitchShiftGraph(el);
		// fire two transposes without awaiting the first — the second must join the in-flight build
		const a = graph.setShift(2);
		const b = graph.setShift(4);
		await Promise.all([a, b]);
		const counts = (globalThis as unknown as { __counts: { source: number; ctx: number } }).__counts;
		expect(counts.source).toBe(1); // exactly one element capture, not two
		expect(counts.ctx).toBe(1); // and exactly one AudioContext, none stranded
		expect(graph.isRouted).toBe(true);
	});
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Merged in from `pitch-shift-instrumental-retry.test.ts`.
 *
 * It was a satellite: a separate file named for ONE behaviour of the module this file already
 * covers. Several files about one module tell a reader nothing about which holds what, so finding
 * where a behaviour is pinned meant opening all of them. The tests are unchanged.
 * ───────────────────────────────────────────────────────────────────────────── */
// Regression guard for "Semitones not affecting instrumental sometimes".
//
// ROOT CAUSE (owner-triaged at 8b115b8, confirmed by reading the code): PitchShiftGraph.build()
// guarded on `if (this.routed || this.degraded) return;` (pitch-shift.ts). `degraded` is set when a
// context cannot reach `running` (no user gesture yet on the TV wall) and NOTHING ever cleared it, so
// it was a PERMANENT verdict rather than "the last attempt failed". The master <audio> element is
// mounted unconditionally and its graph lives as long as the SLOT (kept, not rebuilt, per the song-change reset), so
// once it degraded pre-gesture the instrumental never shifted again -- while the guide element, which
// is remounted with a FRESH graph per song, recovers. That is the "one shifts, the other does not"
// asymmetry the report describes.
//
// FIX: `degraded` describes only the LAST attempt. build() drops `|| this.degraded` from the early
// return and sets `this.degraded = false` at the top of the attempt, so a finished failed attempt is
// retryable. The irreversible createMediaElementSource stays behind the confirmed `state === "running"`
// check, so a retry that fails again closes its context and leaves the element audible (never silent).
//
// Drives the REAL PitchShiftGraph under stubbed WebAudio (same technique as
// pitch-shift-graph-lifetime.test.ts) with ONE knob: whether a fresh AudioContext can be resumed.
// No audio hardware -- the defect is whether the element is ROUTED through the shifter, measured
// directly on the class.


// resume() reaches `running` iff this flag is set when the context is created. Toggling it models the
// TV wall being touched (autoplay unblocked) between two setShift() calls on the same graph.
let canResume = false;

class StubNode {
	connections: unknown[] = [];
	port = { postMessage: (_m: unknown) => {} };
	connect(dest: unknown) {
		this.connections.push(dest);
		return dest as StubNode;
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
	// A context created without a gesture starts suspended; resume() only reaches running when allowed.
	state: 'suspended' | 'running' | 'closed' = 'suspended';
	destination = new StubNode();
	sources: StubSource[] = [];
	async resume() {
		if (canResume) this.state = 'running';
	}
	async close() {
		this.state = 'closed';
	}
	createMediaElementSource(el: unknown) {
		const s = new StubSource(el);
		this.sources.push(s);
		return s as unknown as MediaElementAudioSourceNode;
	}
	createGain() {
		return new StubGain() as unknown as GainNode;
	}
	audioWorklet = { addModule: async (_url: string) => {} };
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown> = {};

beforeEach(() => {
	canResume = false;
	saved = { window: g.window, AudioWorkletNode: g.AudioWorkletNode, Blob: g.Blob, URL: g.URL };
	g.window = { AudioContext: StubAudioContext };
	g.AudioWorkletNode = StubNode;
	g.Blob = class {
		constructor(
			public parts: unknown[],
			public opts: unknown
		) {}
	};
	g.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };
});

afterEach(() => {
	for (const k of Object.keys(saved)) g[k] = saved[k];
});

function fakeEl(): HTMLMediaElement {
	return {} as HTMLMediaElement;
}

test('a graph that degraded pre-gesture RETRIES and routes once a context can resume', async () => {
	// call chain: setShift(shift) -> build() -> new AudioContext().resume() -> state check.
	const graph = new PitchShiftGraph(fakeEl());

	// Pre-gesture press: the TV wall was never touched, so resume() cannot reach running. Correct
	// documented fallback -- audible, unshifted, NOT routed.
	await graph.setShift(2);
	expect(graph.isDegraded).toBe(true);
	expect(graph.isRouted).toBe(false);

	// Someone taps the TV: audio starts, contexts are now resumable. A later semitone press on the
	// SAME (master/instrumental) graph must now route the element through the shifter.
	canResume = true;
	await graph.setShift(3);
	// THIS is the retry assertion: false on base (degraded latched terminal), true with the fix.
	expect(graph.isRouted).toBe(true);
	expect(graph.isDegraded).toBe(false);
});

test('asymmetry: a FRESH graph (what the guide gets each song) always routes when resumable', async () => {
	// The guide's per-song fresh graph recovers because it never carries a stale `degraded`. Pinning
	// this alongside the retry proves the fix removes the asymmetry, not that fresh graphs are special.
	canResume = true;
	const fresh = new PitchShiftGraph(fakeEl());
	await fresh.setShift(3);
	expect(fresh.isRouted).toBe(true);
	expect(fresh.isDegraded).toBe(false);
});

test('not-vacuous control: resumable from the start routes on the first shift', async () => {
	canResume = true;
	const graph = new PitchShiftGraph(fakeEl());
	await graph.setShift(2);
	expect(graph.isRouted).toBe(true);
	expect(graph.isDegraded).toBe(false);
});

test('safety: a retry that STILL cannot resume stays audible (degraded, not routed, no capture)', async () => {
	// If the gesture never comes, retrying must not create the permanent MediaElementSource into a dead
	// context (= total silence). It re-arms degraded and leaves the element on its native output.
	const graph = new PitchShiftGraph(fakeEl());
	await graph.setShift(2);
	expect(graph.isDegraded).toBe(true);
	await graph.setShift(3);
	expect(graph.isDegraded).toBe(true);
	expect(graph.isRouted).toBe(false);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Merged in from `pitch-worklet.test.ts`.
 *
 * It was a satellite: a separate file named for ONE behaviour of the module this file already
 * covers. Several files about one module tell a reader nothing about which holds what, so finding
 * where a behaviour is pinned meant opening all of them. The tests are unchanged.
 * ───────────────────────────────────────────────────────────────────────────── */
// Runs the REAL AudioWorklet source string, not a replica of it.
//
// This file exists because the shipped shifter was numerically broken at every non-zero shift and no
// test could see it: `PITCH_WORKLET_SOURCE` is a string, CI has no AudioContext, and the unit tests only
// covered the ratio arithmetic around it. Mutation testing later confirmed the gap — an off-by-one in
// the output ring survived the entire suite.
//
// The worklet only needs two globals (`AudioWorkletProcessor`, `registerProcessor`), so it can be
// evaluated here with stubs and driven block by block. That keeps the test honest: it exercises the
// exact text that reaches the browser, so it cannot drift from the implementation the way a
// reimplementation of the pointer arithmetic would.


const RATE = 48000;
const BLOCK = 128; // what a browser hands an AudioWorkletProcessor

/** Evaluate the worklet source in a stub scope and return the registered processor class. */
function loadProcessor(): new () => {
	ratio: number;
	readPos: number;
	writePos: number;
	anchored: boolean;
	chan: { hist: Float32Array; outAcc: Float32Array; outNorm: Float32Array }[];
	port: { onmessage: ((e: { data: unknown }) => void) | null };
	process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
} {
	let registered: unknown;
	class StubProcessor {
		port = { onmessage: null as ((e: { data: unknown }) => void) | null };
	}
	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', PITCH_WORKLET_SOURCE)(
		StubProcessor,
		(_name: string, ctor: unknown) => (registered = ctor),
		RATE
	);
	if (!registered) throw new Error('worklet source registered no processor');
	return registered as ReturnType<typeof loadProcessor>;
}

/** Drive `seconds` of a sine through the processor, returning the concatenated output. */
function run(semitones: number, hz: number, seconds: number) {
	const Proc = loadProcessor();
	const p = new Proc();
	p.port.onmessage?.({ data: { ratio: semitonesToRatio(semitones) } });

	const blocks = Math.floor((RATE * seconds) / BLOCK);
	const out = new Float32Array(blocks * BLOCK);
	let n = 0;
	const lags: number[] = [];
	for (let b = 0; b < blocks; b++) {
		const inCh = new Float32Array(BLOCK);
		for (let i = 0; i < BLOCK; i++) inCh[i] = Math.sin((2 * Math.PI * hz * n++) / RATE);
		const outCh = new Float32Array(BLOCK);
		p.process([[inCh]], [[outCh]]);
		out.set(outCh, b * BLOCK);
		if (p.chan[0]) lags.push(p.writePos - p.readPos);
	}
	return { out, lags, proc: p };
}

/** Dominant frequency of a steady sine, via mean zero-crossing rate. Robust enough for one tone. */
function dominantHz(buf: Float32Array, from: number): number {
	let crossings = 0;
	for (let i = from + 1; i < buf.length; i++) {
		if ((buf[i - 1] <= 0 && buf[i] > 0) || (buf[i - 1] >= 0 && buf[i] < 0)) crossings++;
	}
	return crossings / 2 / ((buf.length - from) / RATE);
}

function rms(buf: Float32Array, from: number): number {
	let acc = 0;
	for (let i = from; i < buf.length; i++) acc += buf[i] * buf[i];
	return Math.sqrt(acc / (buf.length - from));
}

// ── the defect this file was written for ─────────────────────────────────────────────────────────

test('THE BUG: the read pointer stays a BOUNDED distance behind the write head at every shift', () => {
	// The shipped shifter advanced readPos by SYNTH_HOP * ratio per grain while writePos advanced
	// SYNTH_HOP, so the lag grew by |1 - ratio| * sampleRate every second — measured at 256,000 samples
	// of drift over 4000 blocks. Unbounded lag IS the bug; every audible symptom follows from it.
	for (const semis of [-7, -5, -3, -1, 1, 3, 5, 7]) {
		const { lags } = run(semis, 220, 3); // 3 s is ~1125 blocks — long enough for drift to dominate
		const ratio = semitonesToRatio(semis);
		const need = readLag(1024, 256, ratio);
		const settled = lags.slice(Math.floor(lags.length / 4)); // skip the startup anchor
		const min = Math.min(...settled);
		const max = Math.max(...settled);
		// The invariant that matters: the read never overtakes the write head, so no grain reads
		// unwritten input. The instantaneous lag dips by up to one hop within a block (the pointer
		// advances on the grain, the write head on the next block), so the floor is the lookahead.
		expect(min).toBeGreaterThanOrEqual(grainLookahead(1024, ratio));
		// And it is BOUNDED above. The anchor is checked BEFORE the SOLA alignment, so alignment may
		// push the lag up to one search width past the band before the next grain re-snaps it.
		expect(max).toBeLessThanOrEqual(need + 1024 + ALIGN_SEARCH + 1);
	}
});

test('THE BUG, stated as growth: the lag does not creep over a song-length run', () => {
	// The sharpest form of the original defect. It drifted by |1 - ratio| * sampleRate every second, so
	// a bound alone could be satisfied by a slow leak — this compares the start and end of a long run.
	// On the shipped code the late mean exceeded the early mean by six figures.
	for (const semis of [-7, -4, 4, 7]) {
		const { lags } = run(semis, 330, 6);
		const settled = lags.slice(Math.floor(lags.length / 5));
		const q = Math.floor(settled.length / 4);
		const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
		const early = mean(settled.slice(0, q));
		const late = mean(settled.slice(-q));
		expect(Math.abs(late - early)).toBeLessThan(ALIGN_SEARCH);
	}
});

test('pitching UP produces audio, not silence', () => {
	// Reading ahead of the write head made every index fail the `absIdx >= writePos` guard, so
	// histSample returned 0 for the whole grain: 2000/2000 future reads, i.e. silence that worsened.
	const { out } = run(+7, 220, 2);
	expect(rms(out, RATE)).toBeGreaterThan(0.5); // a unit sine is 0.707 RMS; OLA is unity gain
});

test('pitching DOWN produces the tone, not aliased noise', () => {
	// Falling behind by more than the ring wrapped `absIdx % HIST` onto unrelated recent audio.
	// A wrapped read is broadband, so the zero-crossing rate explodes; the real tone does not.
	const { out } = run(-7, 220, 2);
	expect(rms(out, RATE)).toBeGreaterThan(0.5);
	expect(dominantHz(out, RATE)).toBeLessThan(220 * 1.5);
});

test('the shift is the RIGHT interval, and tempo is preserved', () => {
	// The pitch must track equal temperament, and the output must stay sample-for-sample aligned with
	// the input (this is a pitch shifter, not a speed control): `blocks * BLOCK` samples in, the same
	// out, which `run` asserts structurally by construction.
	// Only within the UI's own clamp (MAX_KEY_SHIFT = 7). Beyond it the worklet clamps the ratio on
	// purpose, so asserting a 12-semitone shift would be asserting behaviour the product cannot request.
	for (const [semis, tol] of [
		[+7, 0.02],
		[+3, 0.02],
		[0, 0.02],
		[-3, 0.02],
		[-7, 0.02]
	] as const) {
		const { out } = run(semis, 440, 2);
		const expected = 440 * semitonesToRatio(semis);
		const got = dominantHz(out, RATE);
		expect(Math.abs(got - expected) / expected).toBeLessThan(tol);
	}
});

test('ratio 1 is a bit-exact passthrough', () => {
	// The contract the whole graph design rests on: returning to key 0 cannot be distinguishable from
	// never having built the graph, because the element can never be un-sourced.
	const Proc = loadProcessor();
	const p = new Proc();
	const inCh = new Float32Array(BLOCK);
	for (let i = 0; i < BLOCK; i++) inCh[i] = Math.sin((2 * Math.PI * 440 * i) / RATE);
	const outCh = new Float32Array(BLOCK);
	p.process([[inCh]], [[outCh]]);
	expect([...outCh]).toEqual([...inCh]);
});

test('a shift applied then removed returns to passthrough without a stale pointer', () => {
	const Proc = loadProcessor();
	const p = new Proc();
	p.port.onmessage?.({ data: { ratio: semitonesToRatio(5) } });
	for (let b = 0; b < 200; b++) {
		const inCh = new Float32Array(BLOCK).fill(0.5);
		p.process([[inCh]], [[new Float32Array(BLOCK)]]);
	}
	p.port.onmessage?.({ data: { ratio: 1 } });
	const inCh = new Float32Array(BLOCK);
	for (let i = 0; i < BLOCK; i++) inCh[i] = Math.sin((2 * Math.PI * 300 * i) / RATE);
	const outCh = new Float32Array(BLOCK);
	p.process([[inCh]], [[outCh]]);
	expect([...outCh]).toEqual([...inCh]);
	// And re-engaging must re-anchor rather than resume the pointer it had 200 blocks ago.
	p.port.onmessage?.({ data: { ratio: semitonesToRatio(-3) } });
	const { lags } = (() => {
		const l: number[] = [];
		for (let b = 0; b < 400; b++) {
			const i2 = new Float32Array(BLOCK).fill(0.25);
			p.process([[i2]], [[new Float32Array(BLOCK)]]);
			l.push(p.writePos - p.readPos);
		}
		return { lags: l };
	})();
	const need = readLag(1024, 256, semitonesToRatio(-3));
	expect(Math.max(...lags.slice(100))).toBeLessThanOrEqual(need + 1024 + ALIGN_SEARCH + 1);
});

test('a missing input channel yields silence, not a crash or a click', () => {
	const Proc = loadProcessor();
	const p = new Proc();
	p.port.onmessage?.({ data: { ratio: semitonesToRatio(4) } });
	const outCh = new Float32Array(BLOCK);
	expect(p.process([[]], [[outCh]])).toBe(true);
	expect(outCh.every((v) => v === 0)).toBe(true);
});

test('the ratio is clamped, so a spoofed message cannot read past the ring', () => {
	// The history ring is sized from MAX_RATIO. A ratio above it would look ahead further than the ring
	// holds, which is the aliasing this rewrite removes — so the processor clamps rather than trusting.
	const Proc = loadProcessor();
	const p = new Proc();
	p.port.onmessage?.({ data: { ratio: 99 } });
	expect(p.ratio).toBeLessThanOrEqual(1.5);
	expect(grainLookahead(1024, p.ratio)).toBeLessThanOrEqual(4096 - 2 * 256);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Folded in from main's `pitch-worklet.test.ts` (the four-channel guide-mix section).
 *
 * Main added it to `pitch-worklet.test.ts` while this branch had already merged that file into this
 * one, so the change arrives here rather than at its original address. `loadProcessor` is already in
 * scope from the merged block above, which is why it needs no new imports.
 * ───────────────────────────────────────────────────────────────────────────── */

// ── four channels: the guide mix's whole dependency, previously never executed ────────────────────
//
// Every test above drives ONE channel (`[[inCh]]`). The guide mix routes FOUR through this same
// processor — channels 0/1 the instrumental, 2/3 the isolated vocals — and the feature is built on the
// claim that `process()` is channel-generic: it loops `output.length`, keeps per-channel state via
// `ensure(output.length)`, and is a bit-exact passthrough at ratio 1. None of that was ever run at 4.
//
// What makes this worth its own tests rather than a comment: the per-channel state array is what keeps the
// pairs independent, and a bug there does not fail loudly — it CROSS-TALKS. The instrumental would leak
// into the guide pair (which carries the room's guide level) or vice versa, and the audible result is
// exactly the vocals-in-the-wrong-gain outcome the rest of this feature is built to prevent.

/** Drive four channels of distinct content through one processor. */
function run4(semitones: number, hzPerChannel: [number, number, number, number], blocks = 200) {
	const Proc = loadProcessor();
	const p = new Proc();
	p.port.onmessage?.({ data: { ratio: semitonesToRatio(semitones) } });
	const out: Float32Array[] = [0, 1, 2, 3].map(() => new Float32Array(blocks * BLOCK));
	let n = 0;
	for (let b = 0; b < blocks; b++) {
		const ins = hzPerChannel.map((hz) => {
			const ch = new Float32Array(BLOCK);
			for (let i = 0; i < BLOCK; i++) ch[i] = Math.sin((2 * Math.PI * hz * (b * BLOCK + i)) / RATE);
			return ch;
		});
		const outs = [0, 1, 2, 3].map(() => new Float32Array(BLOCK));
		p.process([ins], [outs]);
		for (let c = 0; c < 4; c++) out[c].set(outs[c], n);
		n += BLOCK;
	}
	return { out, proc: p };
}

/** Dominant frequency of a signal, by naive DFT peak over a plausible band. */
function peakHz(sig: Float32Array, from = 100, to = 4000): number {
	let bestHz = 0;
	let bestMag = -1;
	for (let hz = from; hz <= to; hz += 5) {
		let re = 0;
		let im = 0;
		for (let i = 0; i < sig.length; i++) {
			const th = (2 * Math.PI * hz * i) / RATE;
			re += sig[i] * Math.cos(th);
			im += sig[i] * Math.sin(th);
		}
		const mag = re * re + im * im;
		if (mag > bestMag) {
			bestMag = mag;
			bestHz = hz;
		}
	}
	return bestHz;
}

test('4 channels: content state is per-channel, but the timeline is ONE shared pointer', () => {
	const { proc } = run4(0, [200, 200, 900, 900]);
	// `ensure(output.length)` grows the CONTENT state (history ring + output accumulator) to 4, because
	// sharing THAT is the cross-talk failure — the guide pair carrying the instrumental's audio.
	expect(proc.chan.length).toBeGreaterThanOrEqual(4);
	// The TIMELINE, by contrast, is deliberately shared: one read pointer, one write head, one grain
	// schedule live on the processor, not on any channel. That is what keeps the four channels of a mix
	// sample-locked. It must NOT be duplicated onto the per-channel content state, or a per-channel SOLA
	// search could pick a different read offset per channel and the guide would drift from the
	// instrumental — the exact defect this node exists to prevent.
	expect(typeof proc.readPos).toBe('number');
	expect(typeof proc.writePos).toBe('number');
	const s = proc.chan[0] as unknown as Record<string, unknown>;
	expect(s.readPos).toBeUndefined();
	expect(s.writePos).toBeUndefined();
});

test('4 channels shifted: identical inputs on two channels stay SAMPLE-LOCKED at every output sample', () => {
	// THE FIX (guide-vs-instrumental drift on transpose). The SOLA alignment search used to run per
	// channel off per-channel state, so at a non-unity ratio each channel picked its own read offset in
	// +/-256 samples and the four channels of a mix wandered apart by up to ~5 ms — the guiding vocals
	// drifting from the instrumental, invisible to everything downstream of one playhead.
	//
	// Feed the SAME content to channel 0 (instrumental pair) and channel 2 (guide pair) and shift. If the
	// alignment offset is shared, both channels read from an identical input position at every grain, so
	// their outputs are BIT-IDENTICAL. A per-channel search would let them diverge. This is the assertion
	// that a regression to per-channel alignment breaks.
	const { out } = run4(-3, [440, 660, 440, 990]); // ch0 == ch2 content (440 Hz); ch1/ch3 differ
	expect(Array.from(out[2])).toEqual(Array.from(out[0]));
	// And a channel with DIFFERENT content is a different waveform (guards against the trivial pass of
	// every channel emitting silence or a copy).
	expect(Array.from(out[1])).not.toEqual(Array.from(out[0]));
	expect(out[0].some((v) => v !== 0)).toBe(true);
});

test('4 channels at ratio 1: every channel is a bit-exact passthrough of ITS OWN input', () => {
	// The documented fast path, and the case that matters most: at keyShift 0 — the default — a mix song's
	// audio must be byte-identical to the file, per channel, with no pair leaking into the other.
	const Proc = loadProcessor();
	const p = new Proc();
	const ins = [0, 1, 2, 3].map((c) => {
		const ch = new Float32Array(BLOCK);
		for (let i = 0; i < BLOCK; i++) ch[i] = (c + 1) * 0.1 + i * 1e-4;
		return ch;
	});
	const outs = [0, 1, 2, 3].map(() => new Float32Array(BLOCK));
	p.process([ins], [outs]);
	for (let c = 0; c < 4; c++) expect(Array.from(outs[c])).toEqual(Array.from(ins[c]));
});

test('4 channels shifted: each channel keeps its OWN content — no cross-talk between the pairs', () => {
	// 200 Hz on the instrumental pair, 900 Hz on the guide pair, both shifted +4 semitones. If the pairs
	// shared state, the guide pair would carry the instrumental's tone (or a sum), which is audibly the
	// backing track arriving at the guide's gain.
	const ratio = semitonesToRatio(4);
	const { out } = run4(4, [200, 200, 900, 900]);
	const tail = (sig: Float32Array) => sig.subarray(Math.floor(sig.length / 2));
	expect(peakHz(tail(out[0]))).toBeCloseTo(200 * ratio, -1.4);
	expect(peakHz(tail(out[1]))).toBeCloseTo(200 * ratio, -1.4);
	expect(peakHz(tail(out[2]))).toBeCloseTo(900 * ratio, -1.4);
	expect(peakHz(tail(out[3]))).toBeCloseTo(900 * ratio, -1.4);
});

test('4 channels: a missing input channel is silence, not a dropped block', () => {
	// The splitter can hand the worklet fewer input channels than it outputs (a stereo file up-mixed to
	// quad yields [L, R, 0, 0] per the spec's `speakers` rule). That must render as silence on the guide
	// pair, never as a click or a copy of the instrumental — which is what makes a NON-mix song safe to
	// play through a leftover split graph.
	const Proc = loadProcessor();
	const p = new Proc();
	const ins = [0, 1].map(() => {
		const ch = new Float32Array(BLOCK).fill(0.5);
		return ch;
	});
	const outs = [0, 1, 2, 3].map(() => new Float32Array(BLOCK).fill(NaN));
	expect(p.process([ins], [outs])).toBe(true);
	expect(Array.from(outs[0])).toEqual(Array.from(ins[0]));
	expect(Array.from(outs[2])).toEqual(Array.from(new Float32Array(BLOCK)));
	expect(Array.from(outs[3])).toEqual(Array.from(new Float32Array(BLOCK)));
});
