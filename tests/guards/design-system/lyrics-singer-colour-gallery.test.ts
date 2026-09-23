// guard: the components gallery keeps the four frames that are the RENDERED evidence for the
// singer-colour lyric highlight.
//
// The ruling was to keep the singer's hue and lean on the outline the reel already strokes rather than
// derive a legibility-safe variant, which is only defensible if someone can SEE the words hold up when the
// singer's colour collides with the stage behind them. So the gallery carries a pair that ISOLATES the
// change (room accent vs a singer's colour, same doc, same pinned position) plus two collision frames, the
// second painting the stage in EXACTLY the singer's colour so the fill has 1:1 contrast against its own
// background and nothing but the stroke separates them. Delete the cards and the claim is unreproducible.
//
// A SOURCE SCAN: it pins the wiring and the values, not the pixels.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { SINGER_COLORS, lyricHighlightColor } from '$lib/contract';

const src = read('src/routes/components/+page.svelte');

/** The `{#each …}` block holding the singer-colour cards, located by the property only those cards carry. */
const block = /\{#each \[\{[^\]]*singer:[^\]]*\}\][^}]*\}/.exec(src);

test('the gallery carries the singer-colour cards, wired to the prop', () => {
	expect(block).not.toBeNull();
	// Without this the four frames render identically and the evidence proves nothing.
	expect(src).toMatch(/singerColor=\{c\.singer\}/);
	// Pinned and paused, so two frames are comparable: the active word's colour is the whole observable and
	// a running clock makes the pair incommensurable.
	const card = /<LyricsOverlay\b[^<]*?singerColor=\{c\.singer\}[^<]*?\/>/.exec(src);
	expect(card).not.toBeNull();
	expect(card![0]).toMatch(/playing=\{false\}/);
	expect(card![0]).toMatch(/highlight="word"/);
});

test('the cards isolate the change: one frame with no singer, one with a singer, same everything else', () => {
	const cards = block![0];
	// `singer: null` renders the room accent — without it there is nothing to compare against.
	expect(cards).toMatch(/singer:\s*null/);
	// …and at least one frame with a real singer colour.
	expect(cards).toMatch(/singer:\s*(VIOLET|MINT)/);
});

test('the collision frame paints the stage in EXACTLY the singer colour — the case the ruling turns on', () => {
	const cards = block![0];
	// `bg` and `singer` are the same expression, so the highlight sits on a field of its own colour.
	// Softening it to a merely-similar colour retires the only frame that tests the STROKE.
	expect(cards).toMatch(/singer:\s*MINT,\s*bg:\s*MINT/);
	// …plus a realistic mid-tone collision, so the pair is plausible AND worst case.
	expect(cards).toMatch(/singer:\s*MINT,\s*bg:\s*'#[0-9a-f]{6}'/);
});

test('the demo singer colours are real colours the app can produce, not invented literals', () => {
	// Derived from SINGER_COLORS, so a reorder cannot leave the gallery demonstrating a colour no guest can hold.
	expect(src).toMatch(/const MINT = SINGER_COLORS\[7\];/);
	// And it must clear the identity floor: a demo colour the production guard rejects renders the accent
	// and shows nothing.
	expect(lyricHighlightColor(SINGER_COLORS[7])).toBe(SINGER_COLORS[7]);
});
