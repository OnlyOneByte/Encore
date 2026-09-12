// The attract screen's rotating phrase set and its shuffled-bag order (XR-TV-16/17).
//
// The attract screen shows a FIXED `Karaoke` label with one of these phrases rotating beneath it. A
// guest who glances up during any phrase still learns what they are looking at (the label never
// rotates); the phrase is the register the party actually needs — reassurance, not enthusiasm.
//
// Pure (no Svelte, no DOM, no clock) so the two things that must be testable ARE: the admission rule
// is checkable against the DATA, and the bag's ordering properties are checkable against a seeded
// generator. `+page.svelte` owns the 8s clock and the crossfade; this owns the set and the order.

/**
 * The seven ratified phrases, in their canonical (pre-shuffle) order. This is the source of truth for
 * the copy — the mockup's `.pgrid` and `.film` are renders of exactly this set.
 *
 * ADMISSION RULE (XR-TV-16): every phrase is ≤ MAX_PHRASE_CHARS. Measured in-browser at 84px/900 in
 * the 820px attract panel: all seven fit within two lines (the longest, "You know all the words." at
 * 23 chars, is the one that sets the fixed box height); a 30-char control overflows to three lines.
 * 24 is a chosen boundary inside the measured [23 fits, 30 fails] bracket, with one char of headroom.
 * `phrases.test.ts` enforces the bound against THIS array, so a copy edit that overflows the box reds
 * a test rather than shipping a broken wall.
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

export type AttractPhrase = (typeof ATTRACT_PHRASES)[number];

/**
 * The admission ceiling, in characters. A phrase longer than this overflows the fixed two-line box at
 * the attract scale, so it is rejected by `phrases.test.ts` at the DATA layer rather than discovered
 * as a three-line spill on a wall. See XR-TV-16 for the measured derivation.
 */
export const MAX_PHRASE_CHARS = 24;

/**
 * A tiny deterministic PRNG (mulberry32). Seeded, so a room's phrase order is reproducible from its
 * seed alone — which is what makes the bag testable and what lets the same room show a stable sequence
 * across reloads rather than re-randomising on every mount. Not for anything security-sensitive; it is
 * a shuffle seed, nothing more.
 */
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

/**
 * Hash an arbitrary string (a room id or code) to a 32-bit seed, so a room's phrase order is derived
 * from its identity and is stable for that room. FNV-1a — small, deterministic, and dependency-free.
 */
export function seedFromString(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * A Fisher–Yates shuffle of the indices [0, n), driven by a seeded PRNG. Returns a permutation — every
 * index exactly once — which is the property the bag relies on.
 */
function shuffledIndices(n: number, rng: () => number): number[] {
	const idx = Array.from({ length: n }, (_, i) => i);
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[idx[i], idx[j]] = [idx[j]!, idx[i]!];
	}
	return idx;
}

/**
 * The shuffled bag (XR-TV-17). Draws phrases as a random permutation reseeded per room: each pass is
 * the whole set in a shuffled order, and when a pass is exhausted the next pass is a FRESH shuffle — so
 * every phrase is seen once per pass and no phrase repeats until all seven have shown. The only place
 * a repeat could sneak in is across the seam between two passes (the last of pass N and the first of
 * pass N+1); the bag guards that by re-drawing the new pass if its first element equals the previous
 * pass's last, which the tests pin.
 *
 * Deterministic in `seed`: the same seed yields the same infinite sequence, so a room's rotation is
 * reproducible and testable. `next()` returns the next phrase; call it once per 8s tick.
 */
export function makePhraseBag(seed: number, phrases: readonly string[] = ATTRACT_PHRASES) {
	const rng = mulberry32(seed);
	const n = phrases.length;
	let bag: number[] = [];
	let cursor = 0;
	let lastDrawn = -1;

	function refill(): void {
		let order = shuffledIndices(n, rng);
		// No repeat across the pass seam: if the new pass would open with the phrase the previous pass
		// closed with, reshuffle. With n > 1 a shuffle that does not start with `lastDrawn` always exists,
		// so this terminates; n === 1 has no non-repeating order and is left as-is (degenerate set).
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

/**
 * The single phrase held under `prefers-reduced-motion: reduce` (XR-TV-17, XR-TV-05). One phrase is
 * chosen per room from the seed and held for the session with no crossfade — Minecraft's own splash
 * behaviour, the reference rather than a lesser version. Deterministic in the seed so the choice is
 * stable for a room.
 */
export function reducedMotionPhrase(seed: number, phrases: readonly string[] = ATTRACT_PHRASES): string {
	const rng = mulberry32(seed);
	return phrases[Math.floor(rng() * phrases.length)]!;
}
