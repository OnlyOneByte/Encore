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
import { test, expect } from 'bun:test';
import { PITCH_WORKLET_SOURCE, semitonesToRatio, readLag, grainLookahead, ALIGN_SEARCH } from '$lib/tv/pitch-shift';

const RATE = 48000;
const BLOCK = 128; // what a browser hands an AudioWorkletProcessor

/** Evaluate the worklet source in a stub scope and return the registered processor class. */
function loadProcessor(): new () => {
	ratio: number;
	chan: { readPos: number; writePos: number; anchored: boolean }[];
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
		if (p.chan[0]) lags.push(p.chan[0].writePos - p.chan[0].readPos);
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
			l.push(p.chan[0].writePos - p.chan[0].readPos);
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

test('4 channels: per-channel state exists for every channel, so the pairs cannot share a pointer', () => {
	const { proc } = run4(0, [200, 200, 900, 900]);
	// `ensure(output.length)` must have grown the state array to 4. Sharing one channel's read/write
	// pointers across the pairs is the cross-talk failure.
	expect(proc.chan.length).toBeGreaterThanOrEqual(4);
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
