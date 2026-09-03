// Pure SingStar-style scoring logic. No sockets, no I/O — the mic-vs-reference comparison
// and the running-score accumulator, so scoring unit-tests deterministically (the pure-logic/I/O
// split the codebase uses everywhere). The I/O half (loading the reference doc, wiring sockets,
// broadcasting) lives in realtime/scoring.ts.

// The reference pitch-track artifact the worker publishes (Stage 1): a regular time grid,
// frame i covering time i × hopSec. Parallel arrays keep it compact for a whole song.
export interface RefPitchDoc {
	hopSec: number;
	frameCount: number;
	f0Hz: number[];
	midi: number[];
	voiced: boolean[];
}

// Within a semitone of the reference (octave-agnostic) counts as on-pitch. Karaoke-forgiving.
export const HIT_TOLERANCE_CENTS = 100;

/**
 * Octave-agnostic pitch error in cents between two frequencies (0..600). Folding to the nearest
 * octave means a singer an octave below the original (very common — men singing a female track)
 * still scores as on-pitch. Returns Infinity if either frequency is non-positive (no pitch).
 */
export function octaveAgnosticCents(f0: number, refF0: number): number {
	if (f0 <= 0 || refF0 <= 0) return Infinity;
	let cents = 1200 * Math.log2(f0 / refF0);
	cents = ((cents % 1200) + 1200) % 1200; // → 0..1200
	if (cents > 600) cents -= 1200; // → -600..600 (nearest octave)
	return Math.abs(cents);
}

/** Reference frame index covering a playback position (the regular grid → O(1) lookup). */
export function refIndexAt(positionSec: number, hopSec: number): number {
	if (hopSec <= 0) return -1;
	return Math.round(positionSec / hopSec);
}

export interface FrameScore {
	scorable: boolean; // the reference is voiced here (a rest/instrumental frame is never scored)
	hit: boolean; // mic within tolerance of the reference pitch
	cents: number; // octave-agnostic error (Infinity when unscorable or the mic was silent)
}

/**
 * Score one mic sample against the reference at `positionSec`. Only frames where the REFERENCE is
 * voiced are scorable — you're not penalized during rests/instrumental breaks. During a voiced
 * reference frame, a silent mic (f0=0) is a scorable miss; otherwise the octave-agnostic cents
 * error decides the hit.
 */
export function scoreSample(doc: RefPitchDoc, positionSec: number, micF0: number): FrameScore {
	const i = refIndexAt(positionSec, doc.hopSec);
	if (i < 0 || i >= doc.frameCount || !doc.voiced[i]) {
		return { scorable: false, hit: false, cents: Infinity };
	}
	if (micF0 <= 0) return { scorable: true, hit: false, cents: Infinity }; // should sing, but silent
	const cents = octaveAgnosticCents(micF0, doc.f0Hz[i]);
	return { scorable: true, hit: cents <= HIT_TOLERANCE_CENTS, cents };
}

/**
 * Running score for one performance. Accumulates only scorable frames; a hit earns
 * closeness-weighted credit (1 at the reference, → 0 at the tolerance edge), so `score` is a
 * 0..100 rolling accuracy that rises as the singer stays on pitch and stalls when they drift.
 */
export class SessionScorer {
	hits = 0;
	total = 0;
	#points = 0;

	ingest(doc: RefPitchDoc, positionSec: number, micF0: number): void {
		const fs = scoreSample(doc, positionSec, micF0);
		if (!fs.scorable) return;
		this.total++;
		if (fs.hit) {
			this.hits++;
			this.#points += 1 - fs.cents / HIT_TOLERANCE_CENTS; // closeness-weighted credit
		}
	}

	/** 0..100 rolling accuracy (closeness-weighted). 0 before any scorable frame. */
	get score(): number {
		return this.total === 0 ? 0 : Math.round((this.#points / this.total) * 100);
	}
}

/**
 * Parse an untrusted `/media/*.json` pitch artifact into a RefPitchDoc, or null if unusable.
 * Defensive: model/worker output is untrusted, so bad shapes never throw — they disable scoring.
 */
export function parseRefPitchDoc(raw: unknown): RefPitchDoc | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.hopSec !== 'number' || !(r.hopSec > 0)) return null;
	const f0 = Array.isArray(r.f0Hz) ? r.f0Hz.map(Number) : null;
	const voiced = Array.isArray(r.voiced) ? r.voiced.map(Boolean) : null;
	if (!f0 || !voiced || f0.length === 0) return null;
	const midi = Array.isArray(r.midi) ? r.midi.map(Number) : [];
	return { hopSec: r.hopSec, frameCount: f0.length, f0Hz: f0, midi, voiced };
}
