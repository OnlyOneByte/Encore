// Guard: the components gallery keeps the four frames that are the RENDERED evidence for the singer-colour highlight.
//
// WHAT THE CARDS ARE FOR. The singer-colour change paints the lyric highlight in the current singer's colour, and the
// owner's ruling was to keep the hue and lean on the outline the reel already strokes instead of
// deriving a legibility-safe variant. That ruling is only defensible if someone can SEE the words hold
// up when the singer's colour collides with the stage behind them — so the gallery carries a pair that
// isolates the change (room accent vs a singer's colour, same doc, same pinned position) and two
// collision frames, the second of which paints the stage in EXACTLY the singer's colour so the fill has
// 1:1 contrast against its own background and nothing but the stroke separates them.
//
// Those frames are how the CDP evidence in the PR is produced. Delete the cards and the claim becomes
// unreproducible, which is why they are guarded rather than left as decoration — the same reason the
// sibling `lyrics-scale-gallery.test.ts` pins the scale frames to the real band.
//
// A SOURCE SCAN because bun test has no Svelte compiler: it reads the gallery source and pins the
// wiring and the values, not the pixels. It is not mutation-blind — reverting the cards, or unwiring
// `singerColor` from that card's overlay, reds a named test here.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { SINGER_COLORS, lyricHighlightColor } from '$shared';

// A SIBLING READ, re-anchored explicitly. This was `at('apps/core/src/routes/components/+page.svelte')` — and
// `+page.svelte` is the most ambiguous sibling read in the repo, since every route directory has one.
// The subject is the /components GALLERY page, the route this guard has always sat inside, which is
// where the four singer-colour cards live. `read` throws when it is missing, so an ambiguity resolved
// wrongly reds as a path failure instead of scanning some other route's page.
const src = read('apps/core/src/routes/components/+page.svelte');

/** The `{#each …}` block holding the singer-colour cards, located by the property only those cards carry. */
const block = /\{#each \[\{[^\]]*singer:[^\]]*\}\][^}]*\}/.exec(src);

test('the gallery carries the singer-colour cards, wired to the prop', () => {
	expect(block).not.toBeNull();
	// The card's overlay is actually handed the per-card colour. Without this the four frames render
	// identically and the evidence proves nothing — the exact failure this guard exists for.
	expect(src).toMatch(/singerColor=\{c\.singer\}/);
	// Pinned position and paused, so two frames are comparable: the active word's colour is the whole
	// observable and a running clock would make the pair incommensurable.
	const card = /<LyricsOverlay\b[^<]*?singerColor=\{c\.singer\}[^<]*?\/>/.exec(src);
	expect(card).not.toBeNull();
	expect(card![0]).toMatch(/playing=\{false\}/);
	expect(card![0]).toMatch(/highlight="word"/);
});

test('the cards isolate the change: one frame with no singer, one with a singer, same everything else', () => {
	const cards = block![0];
	// The BEFORE frame — `singer: null` renders the room accent, which is what every song painted
	// before this change. Without it there is nothing to compare the singer frame against.
	expect(cards).toMatch(/singer:\s*null/);
	// …and at least one frame with a real singer colour.
	expect(cards).toMatch(/singer:\s*(VIOLET|MINT)/);
});

test('the collision frame paints the stage in EXACTLY the singer colour — the case the ruling turns on', () => {
	const cards = block![0];
	// The pathological floor: `bg` and `singer` are the same expression, so the highlight sits on a
	// field of its own colour. Softening this to a merely-similar colour would quietly retire the only
	// frame that tests the stroke rather than the contrast.
	expect(cards).toMatch(/singer:\s*MINT,\s*bg:\s*MINT/);
	// And a realistic mid-tone collision alongside it, so the pair is "plausible" and "worst case"
	// rather than only the extreme.
	expect(cards).toMatch(/singer:\s*MINT,\s*bg:\s*'#[0-9a-f]{6}'/);
});

test('the demo singer colours are real colours the app can produce, not invented literals', () => {
	// Same discipline as the VIOLET/PINK/GREEN/SKY constants above them: derived from SINGER_COLORS so a
	// reorder of that array cannot leave the gallery demonstrating a colour no guest can hold.
	expect(src).toMatch(/const MINT = SINGER_COLORS\[7\];/);
	// And the colour the collision cards use must actually clear the identity floor the feature applies —
	// a demo colour the production guard would reject renders the accent and shows nothing.
	expect(lyricHighlightColor(SINGER_COLORS[7])).toBe(SINGER_COLORS[7]);
});
