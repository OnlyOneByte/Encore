// THE GALLERY'S FIXTURES — data, not markup. 280-odd of `lib/gallery/Gallery.svelte`'s lines were these
// declarations, which made the one file that is supposed to SHOW components mostly a pile of sample values.
//
// Out here they are importable, so a test can assert against the same `demoLyrics` the gallery renders rather than
// building its own near-copy — which is the failure this move is really about, not the line count.
//
// STILL DEV-ONLY: the gallery is a `.devsvelte` route the build never sees, and nothing in the product imports this.
import {
	DEFAULT_GLOBAL_SETTINGS,
	DEFAULT_ROOM_SETTINGS,
	SINGER_COLORS,
	type LyricsCandidate,
	type SongProfile
} from '$lib/contract';
import type { ComponentProps } from 'svelte';
import type LyricsOverlay from '$lib/tv/LyricsOverlay.svelte';
import type { LyricsDoc } from '$lib/tv/lyrics';

// Fixture singer colours: DATA (a guest's chosen accent), not theme tokens, but taken from the palette by index so a
// reorder cannot leave the gallery demoing a colour the app can no longer produce.
export const VIOLET = SINGER_COLORS[0];
export const PINK = SINGER_COLORS[1];
export const GREEN = SINGER_COLORS[2];
// Mint, because the highlight cards below need a singer colour that collides convincingly with a mid-tone stage field.
export const MINT = SINGER_COLORS[7];

// One constant so the overlay wrappers cannot drift apart, in tokens so it tracks a theme change.
export const stageBg = 'radial-gradient(120% 90% at 50% 20%, var(--stage-glow), var(--bg))';

// A stand-in QR — the real one is generated server-side per room.
export const demoQr =
	'data:image/svg+xml;utf8,' +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" shape-rendering="crispEdges">` +
			`<rect width="64" height="64" fill="#fff"/>` +
			[...Array(64)]
				.map((_, i) => {
					const x = i % 8;
					const y = Math.floor(i / 8);
					// deterministic checker-ish blocks so it reads as a QR without pretending to scan
					return (x * 7 + y * 13) % 3 === 0
						? `<rect x="${x * 8}" y="${y * 8}" width="8" height="8" fill="#0b0b12"/>`
						: '';
				})
				.join('') +
			`</svg>`
	);

// A chorus that lives high, so the histogram weight is visibly lopsided (index 0 = lowMidi = 48/C3); p05..p95 is the
// solid block, low/high the whiskers.
export const profileFull: SongProfile = {
	keyTonic: 7, // G
	keyMode: 'major',
	keyConfidence: 0.82,
	lowMidi: 48, // C3
	highMidi: 72, // C5
	p05Midi: 55, // G3
	p95Midi: 67, // G4
	// 25 semitones C3..C5, weighted upper-middle.
	histogram: [2, 3, 4, 5, 6, 9, 14, 20, 26, 30, 28, 22, 15, 10, 7, 5, 4, 3, 2, 1, 1, 0, 0, 0, 0],
	loudnessLufs: -11.2 // a loud modern master, for the level half of the profile
};
/** Range known, weight unknown: the block must degrade to a flat fill. */
export const profileNoHistogram: SongProfile = { ...profileFull, histogram: null };
/** A key but no measured range, as a silent or instrumental stem gives. The bar renders NOTHING. */
export const profileKeyOnly: SongProfile = {
	keyTonic: 2, // D
	keyMode: 'minor',
	keyConfidence: 0.71,
	lowMidi: null,
	highMidi: null,
	p05Midi: null,
	p95Midi: null,
	histogram: null,
	loudnessLufs: null // unmeasurable level too — never a default, so nothing normalizes it
};

// Word-timed, driven by the auto-advancing clock below so the karaoke sweep is visible here.
export const demoLyrics: LyricsDoc = {
	language: 'en',
	lines: [
		{
			start: 0.0,
			end: 2.6,
			text: 'Is this the real life',
			words: [
				{
					word: 'Is',
					start: 0.0,
					end: 0.408
				},
				{
					word: 'this',
					start: 0.48,
					end: 0.888
				},
				{
					word: 'the',
					start: 0.96,
					end: 1.368
				},
				{
					word: 'real',
					start: 1.44,
					end: 1.848
				},
				{
					word: 'life',
					start: 1.92,
					end: 2.328
				}
			]
		},
		{
			start: 3.0,
			end: 5.6,
			text: 'Is this just fantasy',
			words: [
				{
					word: 'Is',
					start: 3.0,
					end: 3.51
				},
				{
					word: 'this',
					start: 3.6,
					end: 4.11
				},
				{
					word: 'just',
					start: 4.2,
					end: 4.71
				},
				{
					word: 'fantasy',
					start: 4.8,
					end: 5.31
				}
			]
		},
		{
			start: 6.0,
			end: 8.6,
			text: 'Caught in a landslide',
			words: [
				{
					word: 'Caught',
					start: 6.0,
					end: 6.51
				},
				{
					word: 'in',
					start: 6.6,
					end: 7.11
				},
				{
					word: 'a',
					start: 7.2,
					end: 7.71
				},
				{
					word: 'landslide',
					start: 7.8,
					end: 8.31
				}
			]
		},
		{
			start: 9.0,
			end: 11.6,
			text: 'No escape from reality',
			words: [
				{
					word: 'No',
					start: 9.0,
					end: 9.51
				},
				{
					word: 'escape',
					start: 9.6,
					end: 10.11
				},
				{
					word: 'from',
					start: 10.2,
					end: 10.71
				},
				{
					word: 'reality',
					start: 10.8,
					end: 11.31
				}
			]
		},
		{
			start: 12.0,
			end: 14.6,
			text: 'Open your eyes',
			words: [
				{
					word: 'Open',
					start: 12.0,
					end: 12.68
				},
				{
					word: 'your',
					start: 12.8,
					end: 13.48
				},
				{
					word: 'eyes',
					start: 13.6,
					end: 14.28
				}
			]
		},
		{
			start: 15.0,
			end: 17.6,
			text: 'Look up to the skies and see',
			words: [
				{
					word: 'Look',
					start: 15.0,
					end: 15.291
				},
				{
					word: 'up',
					start: 15.343,
					end: 15.634
				},
				{
					word: 'to',
					start: 15.686,
					end: 15.977
				},
				{
					word: 'the',
					start: 16.029,
					end: 16.32
				},
				{
					word: 'skies',
					start: 16.371,
					end: 16.663
				},
				{
					word: 'and',
					start: 16.714,
					end: 17.006
				},
				{
					word: 'see',
					start: 17.057,
					end: 17.349
				}
			]
		}
	],
	words: []
};

/** The line-sync floor: same lines, no per-word timings, as an un-alignable LRC gives. */
export const demoLineOnly: LyricsDoc = {
	language: 'en',
	lines: demoLyrics.lines.map((l) => ({ ...l, words: [] })),
	words: []
};
/** A confident duet as diarization writes one: an abstract `part` letter per line. */
export const demoDuet: LyricsDoc = {
	language: 'en',
	lines: demoLyrics.lines.map((l, i) => ({ ...l, part: i % 2 === 0 ? 'A' : 'B' })),
	words: []
};

/** Proposal 38: a verse, a three-line chorus, a verse, the chorus again. Lines every 2 s, so line N runs N*2 s on. */
const CHORUS_TEXT = [
	'Down the road we drove all night',
	'Radio low and windows wide',
	'Sing it out loud',
	'Everybody now',
	'This one is ours',
	'Morning came up gold and slow',
	'Nowhere else we had to go',
	'Sing it out loud',
	'Everybody now',
	'This one is ours',
	'And then we drove home'
];
const chorusDoc = (extra: (i: number) => Partial<LyricsDoc['lines'][number]> = () => ({})): LyricsDoc => ({
	language: 'en',
	lines: CHORUS_TEXT.map((text, i) => {
		const start = i * 2;
		const words = text.split(' ');
		const step = 1.8 / words.length;
		return {
			start,
			end: start + 1.8,
			text,
			words: words.map((word, k) => ({ word, start: start + k * step, end: start + (k + 0.8) * step })),
			...extra(i)
		};
	}),
	words: []
});
export const demoChorus = chorusDoc();
export const demoChorusDuet = chorusDoc((i) => ({ part: i % 2 === 0 ? 'A' : 'B' }));
/** The chorus graded `low`, as an unanchored repeat often is: whole-line highlight, no wipe. */
export const demoChorusLow = chorusDoc((i) => ((i >= 2 && i <= 4) || (i >= 7 && i <= 9) ? { confidence: 'low' } : {}));
/* The other half of a line-only song: the resolver never sees a doc, only a candidate's `timing`, so a card that
   renders `demoLineOnly` while passing `highlight` by hand cannot exercise the clamp at all. Doc and candidate must
   agree, and both must match what the worker publishes — an empty `words: []` (not an absent key) and `"timing": "line"`. */
export const lineOnlyCandidate: LyricsCandidate = {
	ref: 'derived/lyrics/demo.lrclib.line.json',
	textSource: 'lrclib',
	timing: 'line',
	textConfidence: 'high',
	createdAt: 0
};
// Held as the DEFAULTS, not literals, so the card keeps showing what a fresh install actually does.
export const wordLevelDeployment = { global: DEFAULT_GLOBAL_SETTINGS, room: DEFAULT_ROOM_SETTINGS };

/* Two words a line, for the row-count cards only: the real demo lines wrap at gallery width, which doubles a row's
   height and makes "how many rows are showing" unreadable off a frame. */
export const demoShort: LyricsDoc = {
	language: 'en',
	lines: demoLyrics.lines.map((l) => {
		const words = l.words.slice(0, 2);
		return { ...l, words, text: words.map((w) => w.word).join(' ') || l.text };
	}),
	words: []
};
/* One knob per card, every other at its default. Row-count cards carry their OWN height, derived from it; the doc
   has six lines, so the largest reels reserve rows it cannot fill, and counts are asserted on the DOM. `short`
   picks the two-words-a-line doc, which is what makes a row count readable off a frame. */
export const KNOB_CARDS: {
	what: string;
	props: Partial<ComponentProps<typeof LyricsOverlay>>;
	height: number;
	short: boolean;
}[] = [
	{ what: 'size 100% (the neutral legibility floor)', props: { scalePct: 100 }, height: 500, short: false },
	{ what: 'size 300% (the ceiling)', props: { scalePct: 300 }, height: 900, short: false },
	{ what: 'case ALL CAPS — note the extra wrapping', props: { textCase: 'upper' }, height: 500, short: false },
	{ what: 'case all lowercase', props: { textCase: 'lower' }, height: 500, short: false },
	{ what: 'font serif', props: { font: 'serif' }, height: 500, short: false },
	{ what: 'font monospace — fewest words per row', props: { font: 'mono' }, height: 500, short: false },
	{
		what: 'rows 0 before / 2 after — no history',
		props: { linesBefore: 0, linesAfter: 2 },
		height: 460,
		short: true
	},
	{
		what: 'rows 2 before / 0 after — nothing revealed ahead',
		props: { linesBefore: 2, linesAfter: 0 },
		height: 460,
		short: true
	},
	{
		what: 'rows 2 before / 2 after — the default, for comparison',
		props: { linesBefore: 2, linesAfter: 2 },
		height: 700,
		short: true
	},
	{
		what: 'rows 1 before / 4 after — asymmetric, current line sits high',
		props: { linesBefore: 1, linesAfter: 4 },
		height: 820,
		short: true
	},
	{
		what: 'rows 3 before / 4 after — the maximum reel',
		props: { linesBefore: 3, linesAfter: 4 },
		height: 1080,
		short: true
	}
];
