// — attemptSelection() parses the durable variant-pick provenance a mis-pick is diagnosed from.
// It mirrors attemptStages: a corrupt diagnostic must degrade to "no record", never throw inside a
// dashboard render. RED on base: neither attemptSelection nor SelectionRecord exists there.
import { describe, expect, it } from 'bun:test';
import { attemptSelection, type SelectionRecord } from './types';

const RECORD: SelectionRecord = {
	baselineFallback: false,
	winnerSuspect: false,
	winnerScore: 0.94,
	choices: [
		{
			textSource: 'lrclib',
			considered: 3,
			chosen: 'lrclib-synced',
			chosenScore: 0.94,
			decidedBy: 'agreement',
			votes: 2,
			rejected: [
				{ label: 'lrclib-plain', score: 0.61 },
				{ label: 'captions-stub', score: null }
			]
		}
	]
};

describe('attemptSelection', () => {
	it('round-trips a serialized record, preserving every rejected label and score', () => {
		const got = attemptSelection({ selection: JSON.stringify(RECORD) });
		expect(got).toEqual(RECORD);
		// The two facts that separate #542 arm (b) from arm (c) survive intact.
		const c = got!.choices[0]!;
		expect(c.decidedBy).toBe('agreement');
		expect(c.votes).toBe(2);
		expect(c.rejected).toEqual([
			{ label: 'lrclib-plain', score: 0.61 },
			{ label: 'captions-stub', score: null }
		]);
	});

	it('returns null for an absent record rather than an empty shell', () => {
		expect(attemptSelection({ selection: null })).toBeNull();
	});

	it('degrades malformed JSON to null instead of throwing inside a render', () => {
		expect(attemptSelection({ selection: '{not json' })).toBeNull();
		// well-formed JSON but the wrong shape (no choices array) is also not a record
		expect(attemptSelection({ selection: JSON.stringify({ winnerScore: 1 }) })).toBeNull();
	});

	it('rejects a record whose choices element is missing textSource (A2 — would break the keyed render)', () => {
		// The metrics page keys {#each choices (c.textSource)}; an element from an older/partial worker
		// without textSource would key on undefined and throw at render, the exact thing the guard prevents.
		const bad = JSON.stringify({
			baselineFallback: false,
			winnerSuspect: false,
			winnerScore: 0.9,
			choices: [{ considered: 2, chosen: 'v1', decidedBy: 'agreement', votes: 1, rejected: [] }]
		});
		expect(attemptSelection({ selection: bad })).toBeNull();
	});

	// — the record must also carry the axis `winnerSuspect` is DECIDED on. Since #800 that
	// judgement thresholds baseline COVERAGE, not the ranking score, so a record holding only
	// `winnerScore` reads as a MISSED DETECTION on its own numbers on the normal partial-baseline case:
	// `winnerSuspect: false` beside a score under the documented 0.40, with the number that actually
	// cleared it absent. RED on base: `winnerCoverage` is not a member of SelectionRecord there, so this
	// literal and the read below are both type errors.
	it('round-trips winnerCoverage, the number winnerSuspect was thresholded against', () => {
		const withCoverage: SelectionRecord = { ...RECORD, winnerScore: 0.2906, winnerCoverage: 0.9394 };
		const got = attemptSelection({ selection: JSON.stringify(withCoverage) });
		expect(got).toEqual(withCoverage);
		expect(got!.winnerCoverage).toBe(0.9394);
		// The pair is what makes the record self-explaining: the ranking score sits BELOW the threshold
		// while the coverage that decided it sits above, so `winnerSuspect: false` is no longer a puzzle.
		expect(got!.winnerScore).toBe(0.2906);
	});

	it('an older record with no winnerCoverage still parses — a missing axis is not a bad record', () => {
		// Attempt rows written before #806 have no such key. `attemptSelection` parses defensively, so
		// the honest reading is "this worker did not record it", never a decision made on nothing.
		const got = attemptSelection({ selection: JSON.stringify(RECORD) });
		expect(got).not.toBeNull();
		expect(got!.winnerCoverage).toBeUndefined();
	});
});
