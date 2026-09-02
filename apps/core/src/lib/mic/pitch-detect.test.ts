// M8-C3: client-side f0 detector — a synthesized tone must read back at the right pitch, and
// silence/noise must report no pitch. This is the testable core behind the (browser-only) mic capture.
import { test, expect } from 'bun:test';
import { detectF0 } from './pitch-detect';

const SR = 48000;

function sine(freq: number, seconds: number, sampleRate = SR): Float32Array {
	const n = Math.floor(seconds * sampleRate);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
	return out;
}

test('detectF0: pure tones read back within a quarter-tone', () => {
	for (const f of [110, 220, 330, 440, 523.25]) {
		const { f0Hz, clarity } = detectF0(sine(f, 0.05), SR);
		expect(Math.abs(1200 * Math.log2(f0Hz / f))).toBeLessThan(50); // < 50 cents (quarter-tone)
		expect(clarity).toBeGreaterThan(0.8);
	}
});

test('detectF0: silence and DC offset report no pitch', () => {
	expect(detectF0(new Float32Array(2048), SR).f0Hz).toBe(0);
	const dc = new Float32Array(2048).fill(0.5); // constant → no periodicity
	expect(detectF0(dc, SR).f0Hz).toBe(0);
});

test('detectF0: white noise is rejected by the clarity gate', () => {
	const noise = new Float32Array(2048);
	let seed = 42;
	for (let i = 0; i < noise.length; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff; // deterministic LCG
		noise[i] = (seed / 0x7fffffff) * 2 - 1;
	}
	expect(detectF0(noise, SR).f0Hz).toBe(0);
});

test('detectF0: no octave error — a rich (harmonic) tone still reads the fundamental', () => {
	// fundamental + 2nd/3rd harmonics: naive autocorrelation octave-halves; the peak-picker must not
	const n = Math.floor(0.05 * SR);
	const rich = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		rich[i] = Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t) + 0.3 * Math.sin(2 * Math.PI * 660 * t);
	}
	const { f0Hz } = detectF0(rich, SR);
	expect(Math.abs(1200 * Math.log2(f0Hz / 220))).toBeLessThan(50); // fundamental, not 110/440
});

test('detectF0: empty / bad input is safe', () => {
	expect(detectF0(new Float32Array(0), SR)).toEqual({ f0Hz: 0, clarity: 0 });
	expect(detectF0(sine(440, 0.05), 0)).toEqual({ f0Hz: 0, clarity: 0 });
});
