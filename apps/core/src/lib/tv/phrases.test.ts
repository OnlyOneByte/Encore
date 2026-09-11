// guard (XR-TV-16/17): the attract phrase SET is admissible by construction, and the
// shuffled bag is a per-pass permutation with no repeat until the whole set has shown.
//
// Both are DATA claims, decidable without a DOM: the admission rule reads the exported array's string
// lengths, and the bag's ordering is checkable against a seeded generator. The rendering (the fixed
// two-line box, the crossfade, the reduced-motion hold) is guarded separately in the route.
import { test, expect } from 'bun:test';
import { ATTRACT_PHRASES, MAX_PHRASE_CHARS, makePhraseBag, seedFromString, reducedMotionPhrase } from './phrases';

test('the phrase set is exactly the seven ratified phrases', () => {
	// The set is copy the owner ratified; pin it verbatim so a silent edit to the words is a red test,
	// not a wall nobody looked at. These are the exact strings from the mockup's .pgrid.
	expect([...ATTRACT_PHRASES]).toEqual([
		'No wrong notes.',
		'Mics out.',
		'You know all the words.',
		'Volume beats talent.',
		'Everyone gets a turn.',
		'Pick a banger.',
		'The mic is open.'
	]);
});

test('XR-TV-16: every phrase is admissible — at most 24 characters', () => {
	// The whole point of enforcing the rule against the DATA: a copy edit that overflows the fixed
	// two-line box (measured at 84px/900 in the 820px panel) reds HERE instead of spilling to three
	// lines on a wall. The longest admitted phrase, "You know all the words." at 23, sets the box height.
	const offenders = ATTRACT_PHRASES.filter((p) => p.length > MAX_PHRASE_CHARS).map((p) => `${p} (${p.length})`);
	expect(offenders).toEqual([]);
	// The ceiling itself is the ratified boundary; pin it so a future loosening is a deliberate edit.
	expect(MAX_PHRASE_CHARS).toBe(24);
});

test('XR-TV-16: a 30-character control phrase would be rejected by the same rule', () => {
	// The measured over-length control from the spec: "Nobody is judging you tonight." overflows to
	// three lines. It must fail the admission bound the set passes, or the bound enforces nothing.
	const control = 'Nobody is judging you tonight.';
	expect(control.length).toBeGreaterThan(MAX_PHRASE_CHARS);
});

test('XR-TV-17: each pass is a permutation of the whole set', () => {
	const bag = makePhraseBag(seedFromString('room-alpha'));
	const n = ATTRACT_PHRASES.length;
	for (let pass = 0; pass < 3; pass++) {
		const drawn = Array.from({ length: n }, () => bag.next());
		// every phrase once, no phrase missing, no phrase twice — i.e. a permutation of the set
		expect([...drawn].sort()).toEqual([...ATTRACT_PHRASES].sort());
	}
});

test('XR-TV-17: no phrase repeats across the pass seam', () => {
	// The one place a repeat could sneak in: the last draw of one pass and the first of the next. Draw
	// several full passes and assert no two ADJACENT draws are equal anywhere, including every seam.
	const n = ATTRACT_PHRASES.length;
	for (const room of ['a', 'seed-2', 'the-tuesday-party', 'zzz', '42']) {
		const bag = makePhraseBag(seedFromString(room));
		const seq = Array.from({ length: n * 4 }, () => bag.next());
		for (let i = 1; i < seq.length; i++) {
			expect(seq[i], `adjacent repeat at ${i} for room "${room}"`).not.toBe(seq[i - 1]);
		}
	}
});

test('XR-TV-17: the bag is deterministic in its seed', () => {
	const a = makePhraseBag(12345);
	const b = makePhraseBag(12345);
	const seqA = Array.from({ length: 20 }, () => a.next());
	const seqB = Array.from({ length: 20 }, () => b.next());
	expect(seqA).toEqual(seqB);
	// and a different seed gives a different order (not a constant sequence)
	const c = makePhraseBag(67890);
	const seqC = Array.from({ length: 20 }, () => c.next());
	expect(seqC).not.toEqual(seqA);
});

test('XR-TV-17: the reduced-motion phrase is a member of the set and stable per seed', () => {
	for (const room of ['x', 'y', 'z', 'the-party']) {
		const seed = seedFromString(room);
		const held = reducedMotionPhrase(seed);
		expect(ATTRACT_PHRASES as readonly string[]).toContain(held);
		// stable: the same room holds the same phrase every time it is asked
		expect(reducedMotionPhrase(seed)).toBe(held);
	}
});

test('seedFromString is deterministic and varies by input', () => {
	expect(seedFromString('room-a')).toBe(seedFromString('room-a'));
	expect(seedFromString('room-a')).not.toBe(seedFromString('room-b'));
});
