// Client-side fundamental-frequency (f0) detection. Pure — takes a block of time-domain
// samples (from an AnalyserNode's getFloatTimeDomainData) and returns the detected pitch, so the
// DSP unit-tests against a synthesized tone with no Web Audio (mirrors the worker's pitch_track.py
// autocorrelation approach, in TypeScript). The Web Audio plumbing lives in mic-capture.ts.

export interface F0Result {
	f0Hz: number; // 0 when no confident pitch was found (silence / noise)
	clarity: number; // normalized autocorrelation peak, 0..1 (how periodic the block is)
}

export interface F0Opts {
	fmin?: number; // lowest pitch to look for (Hz)
	fmax?: number; // highest pitch to look for (Hz)
	clarityThreshold?: number; // minimum clarity to report a pitch (else f0Hz=0)
}

// Vocal range, matching the worker (C2..~D6). A tight range rejects sub-harmonic octave errors.
const FMIN = 65;
const FMAX = 1175;
const CLARITY_FLOOR = 0.3;

/**
 * Detect f0 in a block of mono samples via NORMALIZED time-domain autocorrelation. Removes DC, then
 * for each lag divides the raw correlation by the energy of the two overlapping windows — this
 * cancels the `(n − lag)` triangular bias that otherwise pulls the peak below the true period, so
 * the strongest normalized lag sits at the real fundamental and clarity ≈ 1 for a clean tone.
 * Refines the peak with parabolic interpolation (only at a genuine maximum), and gates on clarity so
 * silence and noise report 0.
 */
export function detectF0(samples: Float32Array | number[], sampleRate: number, opts: F0Opts = {}): F0Result {
	const fmin = opts.fmin ?? FMIN;
	const fmax = opts.fmax ?? FMAX;
	const clarityThreshold = opts.clarityThreshold ?? CLARITY_FLOOR;
	const n = samples.length;
	if (n === 0 || sampleRate <= 0) return { f0Hz: 0, clarity: 0 };

	// DC removal so a DC-offset silent block doesn't read as periodic.
	let mean = 0;
	for (let i = 0; i < n; i++) mean += samples[i];
	mean /= n;
	const buf = new Float64Array(n);
	let energy = 0;
	for (let i = 0; i < n; i++) {
		const v = samples[i] - mean;
		buf[i] = v;
		energy += v * v;
	}
	if (energy <= 1e-9) return { f0Hz: 0, clarity: 0 };

	// Prefix sums of squares → O(1) window energy for the per-lag normalization.
	const pfx = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) pfx[i + 1] = pfx[i] + buf[i] * buf[i];

	const minLag = Math.max(1, Math.floor(sampleRate / fmax));
	const maxLag = Math.min(n - 1, Math.floor(sampleRate / fmin));
	if (maxLag <= minLag) return { f0Hz: 0, clarity: 0 };

	const norm = new Float64Array(maxLag + 2);
	let bestNorm = 0;
	for (let lag = minLag; lag <= maxLag; lag++) {
		let corr = 0;
		for (let i = 0; i < n - lag; i++) corr += buf[i] * buf[i + lag];
		const e1 = pfx[n - lag]; // energy of buf[0 .. n-lag)
		const e2 = pfx[n] - pfx[lag]; // energy of buf[lag .. n)
		const nc = e1 > 0 && e2 > 0 ? corr / Math.sqrt(e1 * e2) : 0;
		norm[lag] = nc;
		if (nc > bestNorm) bestNorm = nc;
	}
	const clarity = Math.max(0, Math.min(1, bestNorm));
	if (clarity < clarityThreshold) return { f0Hz: 0, clarity };

	// Normalized ACF peaks equally at the true period AND its multiples (2×, 3× → octave-down
	// errors), so plain argmax can latch onto a subharmonic. Instead pick the SHORTEST-lag peak that
	// clears a fraction of the global max — the fundamental, McLeod-style.
	const threshold = 0.9 * bestNorm;
	let bestLag = -1;
	for (let lag = minLag + 1; lag < maxLag; lag++) {
		if (norm[lag] >= threshold && norm[lag] >= norm[lag - 1] && norm[lag] >= norm[lag + 1]) {
			bestLag = lag;
			break;
		}
	}
	if (bestLag < 0) return { f0Hz: 0, clarity }; // strong but no clean peak (edge-dominated)

	// Parabolic interpolation ONLY at a genuine local maximum (concave), else keep the integer lag.
	let lag = bestLag;
	const y0 = norm[bestLag - 1];
	const y1 = norm[bestLag];
	const y2 = norm[bestLag + 1];
	const denom = y0 - 2 * y1 + y2;
	if (denom < 0) {
		const shift = (0.5 * (y0 - y2)) / denom;
		if (shift > -1 && shift < 1) lag = bestLag + shift;
	}

	return { f0Hz: lag > 0 ? sampleRate / lag : 0, clarity };
}
