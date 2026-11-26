import {
	ALIGN_SEARCH,
	PITCH_WORKLET_SOURCE,
	PitchShiftGraph,
	grainLookahead,
	needsShift,
	readLag,
	semitonesToRatio,
	WORKLET_LOAD_MS
} from '$lib/tv/pitch-shift';
import { afterEach, beforeEach, expect, test } from 'bun:test';

// The browser pitch shifter: ratio arithmetic, the OLA framing maths, the graph's control flow, and the REAL worklet
// source driven block by block under stub globals. Audible behaviour is NOT decidable here: no audio hardware, no
// AudioContext.

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
	// 7 semitones — the ±MAX_KEY_SHIFT bound the UI can request.
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
	// The resample is FUSED into the grain read, so the hop must not ALSO be scaled by ratio: doing both applies the tempo
	// correction twice and the read pointer runs away from the write pointer without bound. A slow read needs LESS
	// lookahead — at ratio 0.5 a 1024-sample grain spans 512 input.
	expect(grainLookahead(1024, 1)).toBe(1024);
	expect(grainLookahead(1024, 2)).toBe(2048);
	expect(grainLookahead(1024, 0.5)).toBe(512);
	// The lag adds the alignment search and one hop, so neither a block edge nor the SOLA search reads past the newest
	// input.
	expect(readLag(1024, 256, 1)).toBe(1024 + ALIGN_SEARCH + 256);
	expect(readLag(1024, 256, 1.5)).toBe(1536 + ALIGN_SEARCH + 256);
});

// setShift needs an in-flight guard, because `routed` only flips AFTER `await ctx.resume()` and `await addModule(…)`:
// two setShift(non-zero) calls in that async window — two playback:state broadcasts ~10ms apart from a guest
// double-tapping ±key — both pass an entry check, both call the IRREVERSIBLE createMediaElementSource, and the second
// throws and strands an AudioContext. The fakes below resolve on a later microtask so two calls genuinely interleave
// inside build(); the counters are what the assertion reads.
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

// `degraded` must describe only the LAST attempt, never latch: it is set when a context cannot reach `running` (no user
// gesture yet on the TV wall), and the master <audio>'s graph lives as long as the SLOT, so a permanent verdict means
// the instrumental never shifts again for that song — while the guide, remounted with a FRESH graph per song, recovers.
// That asymmetry is the reported defect. The irreversible createMediaElementSource must stay behind a confirmed `state
// === "running"`, so a retry that fails again closes its context and leaves the element audible rather than silent.

// resume() reaches `running` iff this flag is set when the context is created. Toggling it models the TV wall being
// touched (autoplay unblocked) between two setShift() calls on the same graph.
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
	const graph = new PitchShiftGraph(fakeEl());

	// Pre-gesture press: the wall was never touched, so resume() cannot reach running. The documented fallback is
	// audible, unshifted, NOT routed.
	await graph.setShift(2);
	expect(graph.isDegraded).toBe(true);
	expect(graph.isRouted).toBe(false);

	// Someone taps the TV: audio starts, contexts are now resumable. A later semitone press on the SAME
	// (master/instrumental) graph must now route the element through the shifter.
	canResume = true;
	await graph.setShift(3);
	expect(graph.isRouted).toBe(true);
	expect(graph.isDegraded).toBe(false);
});

test('asymmetry: a FRESH graph (what the guide gets each song) always routes when resumable', async () => {
	// A fresh graph never carries a stale `degraded`, so pinning it beside the retry shows the asymmetry is gone rather
	// than that fresh graphs are special.
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
	// If the gesture never comes, retrying must not create the permanent MediaElementSource into a dead context (= total
	// silence). It re-arms degraded and leaves the element on its native output.
	const graph = new PitchShiftGraph(fakeEl());
	await graph.setShift(2);
	expect(graph.isDegraded).toBe(true);
	await graph.setShift(3);
	expect(graph.isDegraded).toBe(true);
	expect(graph.isRouted).toBe(false);
});

// Runs the REAL AudioWorklet source string, never a replica: a reimplementation of the pointer arithmetic would drift
// from the text that reaches the browser. The worklet needs only `AudioWorkletProcessor` and `registerProcessor`, so
// stubs are enough to drive it block by block.

const RATE = 48000;
const BLOCK = 128; // what a browser hands an AudioWorkletProcessor

/** The worklet source, evaluated ONCE in a stub scope; each test makes its own instance. Re-evaluating per run made
 *  every run JIT `process()` from cold, which overran the 5 s budget on a loaded host (#1073). */
let processorClass: ReturnType<typeof evaluateWorklet> | undefined;
function loadProcessor(): ReturnType<typeof evaluateWorklet> {
	return (processorClass ??= evaluateWorklet());
}

function evaluateWorklet(): new () => {
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
	new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', PITCH_WORKLET_SOURCE)(
		StubProcessor,
		(_name: string, ctor: unknown) => (registered = ctor),
		RATE
	);
	if (!registered) throw new Error('worklet source registered no processor');
	return registered as ReturnType<typeof evaluateWorklet>;
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

test('THE BUG: the read pointer stays a BOUNDED distance behind the write head at every shift', () => {
	// Unbounded lag is the defect every audible symptom follows from: advancing readPos by SYNTH_HOP * ratio per grain
	// while writePos advances SYNTH_HOP grows the lag by |1 - ratio| * sampleRate per second.
	for (const semis of [-7, -5, -3, -1, 1, 3, 5, 7]) {
		const { lags } = run(semis, 220, 3); // 3 s is ~1125 blocks — long enough for drift to dominate
		const ratio = semitonesToRatio(semis);
		const need = readLag(1024, 256, ratio);
		const settled = lags.slice(Math.floor(lags.length / 4)); // skip the startup anchor
		const min = Math.min(...settled);
		const max = Math.max(...settled);
		// The read never overtakes the write head, so no grain reads unwritten input. The instantaneous lag dips by up to
		// one hop within a block (the pointer advances on the grain, the write head on the next block), so the floor is
		// the lookahead.
		expect(min).toBeGreaterThanOrEqual(grainLookahead(1024, ratio));
		// And BOUNDED above. The anchor is checked BEFORE the SOLA alignment, so alignment may push the lag up to one
		// search width past the band before the next grain re-snaps it.
		expect(max).toBeLessThanOrEqual(need + 1024 + ALIGN_SEARCH + 1);
	}
});

test('THE BUG, stated as growth: the lag does not creep over a song-length run', () => {
	// A bound alone can be satisfied by a slow leak, so compare the start and end of a long run.
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
	// Reading ahead of the write head fails the `absIdx >= writePos` guard for the whole grain, so histSample returns 0 —
	// silence that worsens over time.
	const { out } = run(+7, 220, 2);
	expect(rms(out, RATE)).toBeGreaterThan(0.5); // a unit sine is 0.707 RMS; OLA is unity gain
});

test('pitching DOWN produces the tone, not aliased noise', () => {
	// Falling behind by more than the ring wraps `absIdx % HIST` onto unrelated recent audio; a wrapped read is
	// broadband, so the zero-crossing rate explodes where the real tone's does not.
	const { out } = run(-7, 220, 2);
	expect(rms(out, RATE)).toBeGreaterThan(0.5);
	expect(dominantHz(out, RATE)).toBeLessThan(220 * 1.5);
});

test('the shift is the RIGHT interval, and tempo is preserved', () => {
	// Equal temperament, sample-for-sample aligned with the input — a pitch shifter, not a speed control. Only within the
	// UI's own clamp (MAX_KEY_SHIFT = 7): beyond it the worklet clamps the ratio deliberately, so a 12-semitone
	// assertion would assert behaviour the product cannot request.
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
	// The contract the graph design rests on: returning to key 0 must be indistinguishable from never having built the
	// graph, because the element can never be un-sourced.
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
	// The history ring is sized from MAX_RATIO, so a higher ratio would look ahead past what the ring holds and alias.
	// The processor clamps rather than trusting the message.
	const Proc = loadProcessor();
	const p = new Proc();
	p.port.onmessage?.({ data: { ratio: 99 } });
	expect(p.ratio).toBeLessThanOrEqual(1.5);
	expect(grainLookahead(1024, p.ratio)).toBeLessThanOrEqual(4096 - 2 * 256);
});

// Four channels — the guide mix's whole dependency. Every test above drives ONE channel; the guide mix routes FOUR
// through this same processor (0/1 instrumental, 2/3 isolated vocals) and rests on `process()` being channel-generic. A
// bug in the per-channel state array does not fail loudly, it CROSS-TALKS: the instrumental leaks into the guide pair,
// audibly the vocals arriving at the wrong gain.

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

/** Squared DFT magnitude of a signal at one frequency. */
function dftMag(sig: Float32Array, hz: number): number {
	// The phasor is rotated by one complex multiply per sample, not a sin and a cos: per-sample trig made this
	// helper ~97% of the test, and past the 5 s budget whenever JSC left it unoptimised (#1073).
	const th = (2 * Math.PI * hz) / RATE;
	const dc = Math.cos(th);
	const ds = Math.sin(th);
	let c = 1;
	let s = 0;
	let re = 0;
	let im = 0;
	for (let i = 0; i < sig.length; i++) {
		re += sig[i] * c;
		im += sig[i] * s;
		const nc = c * dc - s * ds;
		s = s * dc + c * ds;
		c = nc;
	}
	return re * re + im * im;
}

/** Dominant frequency of a signal, by naive DFT peak over a plausible band. */
function peakHz(sig: Float32Array, from = 100, to = 4000): number {
	let bestHz = 0;
	let bestMag = -1;
	for (let hz = from; hz <= to; hz += 5) {
		const mag = dftMag(sig, hz);
		if (mag > bestMag) {
			bestMag = mag;
			bestHz = hz;
		}
	}
	return bestHz;
}

test('4 channels: content state is per-channel, but the timeline is ONE shared pointer', () => {
	const { proc } = run4(0, [200, 200, 900, 900]);
	// CONTENT state (history ring, output accumulator) is per channel: sharing it is the cross-talk case.
	expect(proc.chan.length).toBeGreaterThanOrEqual(4);
	// The TIMELINE is deliberately SHARED — one read pointer, one write head, one grain schedule, all on the processor
	// and on no channel. Duplicating it per channel lets a per-channel SOLA search pick a different read offset each,
	// and the guide drifts from the instrumental.
	expect(typeof proc.readPos).toBe('number');
	expect(typeof proc.writePos).toBe('number');
	const s = proc.chan[0] as unknown as Record<string, unknown>;
	expect(s.readPos).toBeUndefined();
	expect(s.writePos).toBeUndefined();
});

test('4 channels shifted: identical inputs on two channels stay SAMPLE-LOCKED at every output sample', () => {
	// Same content on channel 0 (instrumental pair) and 2 (guide pair), then shift: a SHARED alignment offset makes both
	// read from an identical input position at every grain, so the outputs are BIT-IDENTICAL. A per-channel search lets
	// them diverge by up to ±256 samples (~5 ms) — the guide drifting, invisible downstream of one playhead.
	const { out } = run4(-3, [440, 660, 440, 990]); // ch0 == ch2 content (440 Hz); ch1/ch3 differ
	expect(Array.from(out[2])).toEqual(Array.from(out[0]));
	// And a channel with DIFFERENT content is a different waveform (guards the trivial pass of every channel emitting
	// silence or a copy).
	expect(Array.from(out[1])).not.toEqual(Array.from(out[0]));
	expect(out[0].some((v) => v !== 0)).toBe(true);
});

test('4 channels at ratio 1: every channel is a bit-exact passthrough of ITS OWN input', () => {
	// The default case: at keyShift 0 a mix song's audio must be byte-identical to the file, per channel, with no pair
	// leaking into the other.
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
	// Shared state would make the guide pair carry the instrumental's tone (or a sum), audibly the backing track
	// arriving at the guide's gain.
	const ratio = semitonesToRatio(4);
	const { out } = run4(4, [200, 200, 900, 900]);
	// The last quarter: steady state, and half the DFT work of the second half at a 7.5 Hz resolution.
	const tail = (sig: Float32Array) => sig.subarray(Math.floor((sig.length * 3) / 4));
	expect(peakHz(tail(out[0]))).toBeCloseTo(200 * ratio, -1.4);
	expect(peakHz(tail(out[1]))).toBeCloseTo(200 * ratio, -1.4);
	expect(peakHz(tail(out[2]))).toBeCloseTo(900 * ratio, -1.4);
	expect(peakHz(tail(out[3]))).toBeCloseTo(900 * ratio, -1.4);
	// A summed leak leaves the guide's peak where it was, so the peak alone misses it (#1136): the guide pair must
	// also carry almost nothing at the instrumental's shifted tone, by magnitude, under 1% of its own peak's.
	const leak = (guide: Float32Array) => {
		const g = tail(guide);
		return Math.sqrt(dftMag(g, 200 * ratio) / dftMag(g, 900 * ratio));
	};
	expect(leak(out[2])).toBeLessThan(0.01);
	expect(leak(out[3])).toBeLessThan(0.01);
	// And that check does catch a sum, at the gains the #1122 review mixed in.
	for (const gain of [0.25, 0.5, 1]) {
		const summed = out[2].map((v, i) => v + gain * out[0][i]);
		expect(leak(summed), `a leak at gain ${gain}`).toBeGreaterThan(0.01);
	}
});

test('4 channels: a missing input channel is silence, not a dropped block', () => {
	// The splitter can hand the worklet fewer input channels than it outputs (a stereo file up-mixed to quad is
	// [L, R, 0, 0] per the spec's `speakers` rule). Silence on the guide pair — never a click or a copy of the
	// instrumental — is what makes a NON-mix song safe through a leftover split graph.
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

test('histSample refuses an out-of-range index instead of wrapping onto unrelated audio', () => {
	// The contract is stated in the worklet two lines above `histSample` — "Out of range returns 0, NOT a
	// wrapped neighbour, because a wrapped read is unrelated audio" — and NOTHING verified it, which is how
	// it came to be false. Both guards read the write head off `s`, the per-channel entry, which has none:
	// the 4-channel test above pins that the timeline lives on the processor and never on a channel. So
	// `absIdx >= undefined` and `absIdx < NaN` were both false, every out-of-range read fell through to
	// `hist[absIdx % HIST]`, and the function returned exactly the wrapped neighbour it forbids.
	const { proc } = run(0, 220, 0.2);
	const p = proc as unknown as {
		writePos: number;
		chan: { hist: Float32Array }[];
		histSample(s: { hist: Float32Array }, absIdx: number): number;
	};
	const s = p.chan[0]!;
	const HIST = s.hist.length;

	// Reading PAST the write head, and reading FURTHER BACK than the ring holds.
	const ahead = p.writePos + 64;
	const tooOld = p.writePos - HIST - 64;
	expect(p.histSample(s, ahead)).toBe(0);
	expect(p.histSample(s, tooOld)).toBe(0);
	expect(p.histSample(s, -1)).toBe(0);

	// Non-vacuity, and the whole point: the wrapped slots those indices land on hold REAL audio, so a guard
	// that did nothing would return a non-zero sample from an unrelated part of the song rather than 0.
	const wrappedAhead = s.hist[((ahead % HIST) + HIST) % HIST]!;
	const wrappedOld = s.hist[((tooOld % HIST) + HIST) % HIST]!;
	expect(Math.abs(wrappedAhead) + Math.abs(wrappedOld)).toBeGreaterThan(0);

	// An index INSIDE the window still reads its sample — the guards refuse, they do not mute.
	const inside = p.writePos - 1;
	expect(p.histSample(s, inside)).toBe(s.hist[inside % HIST]);
});

/** A context that can split a 4-channel mix, with a worklet load that takes `loadMs` (Infinity: never settles). */
function mixContext(loadMs: number) {
	return class extends StubAudioContext {
		override audioWorklet = {
			addModule: (_url: string) =>
				loadMs === Infinity ? new Promise<void>(() => {}) : new Promise<void>((r) => setTimeout(r, loadMs))
		};
		createChannelSplitter() {
			return new StubNode() as unknown as ChannelSplitterNode;
		}
		createChannelMerger() {
			return new StubNode() as unknown as ChannelMergerNode;
		}
	};
}
const settlesWithin = <T>(p: Promise<T>, ms: number) =>
	Promise.race([p.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), ms))]);

test('#1293 a worklet load that never settles: the guide-mix build still settles, split and routed, without ±key', async () => {
	canResume = true;
	g.window = { AudioContext: mixContext(Infinity) };
	const graph = new PitchShiftGraph(fakeEl(), { split: true, workletLoadMs: 50 });
	expect(await settlesWithin(graph.ensureRouted(), 2_000), 'ensureRouted never settled').toBe(true);
	expect(graph.isRouted).toBe(true);
	expect(graph.isSplit).toBe(true);
	expect(graph.isShiftable).toBe(false);
});

test('#1293 a slow worklet load that does arrive inside the bound still gets its shifter', async () => {
	canResume = true;
	g.window = { AudioContext: mixContext(30) };
	const graph = new PitchShiftGraph(fakeEl(), { split: true, workletLoadMs: 500 });
	await graph.ensureRouted();
	expect(graph.isRouted).toBe(true);
	expect(graph.isShiftable).toBe(true);
});

test('#1293 a load that lands just past the bound changes nothing: routed and split, no ±key, no worklet node', async () => {
	canResume = true;
	g.window = { AudioContext: mixContext(80) };
	const graph = new PitchShiftGraph(fakeEl(), { split: true, workletLoadMs: 50 });
	await graph.ensureRouted();
	await new Promise((r) => setTimeout(r, 60)); // the late load resolves after the build has moved on
	expect(graph.isRouted).toBe(true);
	expect(graph.isSplit).toBe(true);
	expect(graph.isShiftable).toBe(false);
	expect((graph as unknown as { node: unknown }).node).toBeNull();
});

test('#1293 the production bound is generous: a slow box keeps its worklet', () => {
	expect(WORKLET_LOAD_MS).toBeGreaterThanOrEqual(10_000);
});
