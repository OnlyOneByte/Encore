// Pure scoring logic — octave-agnostic cents, reference-frame lookup, per-sample scoring,
// the running-score accumulator, and defensive artifact parsing.
import { test, expect } from 'bun:test';
import {
	octaveAgnosticCents,
	refIndexAt,
	scoreSample,
	SessionScorer,
	parseRefPitchDoc,
	HIT_TOLERANCE_CENTS,
	type RefPitchDoc
} from './scorer';

test('octaveAgnosticCents: exact match 0, semitone ~100, octave folds to 0', () => {
	expect(octaveAgnosticCents(440, 440)).toBeCloseTo(0, 5);
	expect(octaveAgnosticCents(466.16, 440)).toBeCloseTo(100, 0); // A→A# ≈ one semitone
	expect(octaveAgnosticCents(880, 440)).toBeCloseTo(0, 5); // octave up → same pitch class
	expect(octaveAgnosticCents(220, 440)).toBeCloseTo(0, 5); // octave down → same pitch class
	expect(octaveAgnosticCents(0, 440)).toBe(Infinity); // no pitch
});

test('refIndexAt: rounds position to the nearest grid frame', () => {
	expect(refIndexAt(0, 0.01)).toBe(0);
	expect(refIndexAt(0.104, 0.01)).toBe(10);
	expect(refIndexAt(0.106, 0.01)).toBe(11);
	expect(refIndexAt(1, 0)).toBe(-1); // guard against a bad hopSec
});

const doc: RefPitchDoc = {
	hopSec: 0.01,
	frameCount: 5,
	f0Hz: [0, 220, 220, 440, 0],
	midi: [0, 57, 57, 69, 0],
	voiced: [false, true, true, true, false]
};

test('scoreSample: unvoiced reference is not scorable; voiced hit/miss by cents', () => {
	expect(scoreSample(doc, 0.0, 220).scorable).toBe(false); // ref frame 0 unvoiced (rest)
	expect(scoreSample(doc, 0.04, 440).scorable).toBe(false); // ref frame 4 unvoiced
	const onPitch = scoreSample(doc, 0.01, 220); // frame 1 ref=220, sing 220
	expect(onPitch).toMatchObject({ scorable: true, hit: true });
	const octaveDown = scoreSample(doc, 0.03, 220); // frame 3 ref=440, sing 220 (octave) → still hit
	expect(octaveDown.hit).toBe(true);
	const flat = scoreSample(doc, 0.01, 261.6); // frame 1 ref=220, sing C4 (~330c off) → miss
	expect(flat).toMatchObject({ scorable: true, hit: false });
	const silent = scoreSample(doc, 0.01, 0); // should sing but silent → scorable miss
	expect(silent).toMatchObject({ scorable: true, hit: false });
});

test('SessionScorer: only scorable frames count; on-pitch rises toward 100', () => {
	const s = new SessionScorer();
	s.ingest(doc, 0.0, 220); // unvoiced ref → ignored
	expect(s.total).toBe(0);
	s.ingest(doc, 0.01, 220); // hit
	s.ingest(doc, 0.02, 220); // hit
	s.ingest(doc, 0.03, 440); // hit
	expect(s.total).toBe(3);
	expect(s.hits).toBe(3);
	expect(s.score).toBe(100); // perfectly on pitch

	const m = new SessionScorer();
	m.ingest(doc, 0.01, 220); // hit
	m.ingest(doc, 0.02, 130.8); // way off → miss
	expect(m.hits).toBe(1);
	expect(m.total).toBe(2);
	expect(m.score).toBeGreaterThan(0);
	expect(m.score).toBeLessThan(100);
});

test('parseRefPitchDoc: valid → doc; junk/short → null', () => {
	const parsed = parseRefPitchDoc({ hopSec: 0.01, f0Hz: [0, 440], midi: [0, 69], voiced: [false, true] });
	expect(parsed).not.toBeNull();
	expect(parsed!.frameCount).toBe(2);
	expect(parseRefPitchDoc(null)).toBeNull();
	expect(parseRefPitchDoc({ hopSec: 0 })).toBeNull();
	expect(parseRefPitchDoc({ hopSec: 0.01, f0Hz: [], voiced: [] })).toBeNull();
	expect(parseRefPitchDoc('nope')).toBeNull();
});

test('HIT_TOLERANCE_CENTS is a semitone-scale forgiveness', () => {
	expect(HIT_TOLERANCE_CENTS).toBe(100);
});
