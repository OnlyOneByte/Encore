// The attract screen's rotating phrase set and its shuffled-bag order. Pure (no Svelte, no DOM, no clock):
// the admission rule is checkable against the DATA and the bag's ordering against a seeded generator.

/**
 * The ratified phrases in canonical (pre-shuffle) order. Every one must be <= MAX_PHRASE_CHARS, enforced
 * against THIS array so a copy edit that overflows the attract panel's fixed two-line box reds a test.
 */
export const ATTRACT_PHRASES = [
	'No wrong notes.',
	'Mics out.',
	'You know all the words.',
	'Volume beats talent.',
	'Everyone gets a turn.',
	'Pick a banger.',
	'The mic is open.'
] as const;

/**
 * The admission ceiling, in characters. Measured in-browser at 84px/900 in the 820px attract panel: 23 chars
 * fits two lines, 30 spills to three, so 24 sits inside that bracket with one char of headroom.
 */
export const MAX_PHRASE_CHARS = 24;

/** Deterministic PRNG, so a room's phrase order is reproducible from its seed and stable across reloads. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Hash a room id or code to a 32-bit seed, so the order is derived from the room's identity. FNV-1a. */
export function seedFromString(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Fisher-Yates over [0, n). Returns a PERMUTATION — every index exactly once, which the bag relies on. */
function shuffledIndices(n: number, rng: () => number): number[] {
	const idx = Array.from({ length: n }, (_, i) => i);
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[idx[i], idx[j]] = [idx[j]!, idx[i]!];
	}
	return idx;
}

/**
 * The shuffled bag: each pass is the whole set in a shuffled order, and an exhausted pass is refilled with a
 * FRESH shuffle, so no phrase repeats until every one has shown. The one place a repeat could sneak in is the
 * seam between two passes, which `refill` re-draws against. Deterministic in `seed`.
 */
export function makePhraseBag(seed: number, phrases: readonly string[] = ATTRACT_PHRASES) {
	const rng = mulberry32(seed);
	const n = phrases.length;
	let bag: number[] = [];
	let cursor = 0;
	let lastDrawn = -1;

	function refill(): void {
		let order = shuffledIndices(n, rng);
		// With n > 1 a shuffle not starting on `lastDrawn` always exists, so this terminates; n === 1 has no
		// non-repeating order and is left alone.
		if (n > 1) {
			let guard = 0;
			while (order[0] === lastDrawn && guard < 64) {
				order = shuffledIndices(n, rng);
				guard++;
			}
		}
		bag = order;
		cursor = 0;
	}

	return {
		/** The next phrase in the bag, advancing the cursor and refilling (reshuffling) when exhausted. */
		next(): string {
			if (cursor >= bag.length) refill();
			const i = bag[cursor]!;
			cursor++;
			lastDrawn = i;
			return phrases[i]!;
		}
	};
}

/** The single phrase held under `prefers-reduced-motion: reduce`, so the choice is stable for a room. */
export function reducedMotionPhrase(seed: number, phrases: readonly string[] = ATTRACT_PHRASES): string {
	const rng = mulberry32(seed);
	return phrases[Math.floor(rng() * phrases.length)]!;
}
