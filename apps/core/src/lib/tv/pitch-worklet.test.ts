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
import {
	PITCH_WORKLET_SOURCE,
	semitonesToRatio,
	readLag,
	grainLookahead,
	ALIGN_SEARCH
} from './pitch-shift';

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
	new Function(
		'AudioWorkletProcessor',
		'registerProcessor',
		'sampleRate',
		PITCH_WORKLET_SOURCE
	)(StubProcessor, (_name: string, ctor: unknown) => (registered = ctor), RATE);
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
	return (crossings / 2 / ((buf.length - from) / RATE));
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
