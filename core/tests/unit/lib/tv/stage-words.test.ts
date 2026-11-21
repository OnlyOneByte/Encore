import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { at, read } from '$test';
import { formatClock, formatRemaining, formatRemainingAscii } from '$lib/clock';
import type { MediaStatus } from '$lib/contract';
import { processStageLabel } from '$lib/phrasing/process-phrasing';
import { NOW_SINGING, UP_NEXT } from '$lib/phrasing/turn-phrasing';
import { keyShiftLabel } from '$lib/song-facts';
import { UNREACHABLE_JOIN, UNREACHABLE_JOIN_FIX } from '$lib/tv/join-address';
import { ATTRACT_PHRASES } from '$lib/tv/phrases';
import { PROCESS_STEPS } from '$lib/tv/screen';

/*
 * guard: THE STAGE IS FOR THE ROOM (proposal 09). The TV shows the singer, the song, who's next and how to join.
 * Operator words — our data source, a music-theory key name, a setup warning — were deleted from it, and this
 * register keeps a deleted string from coming back in silence. Sources are read as TEXT with comments stripped,
 * because the prose in these files quotes the strings it retired.
 */
function strip(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
}

const tvFiles = [
	'src/routes/tv/+page.svelte',
	...readdirSync(at('src/lib/tv'))
		.filter((f) => /\.(svelte|ts)$/.test(f))
		.map((f) => `src/lib/tv/${f}`)
];
const tv = tvFiles.map((f) => ({ f, text: strip(read(f)) }));

test('no TV source carries a retired operator string', () => {
	const retired = [
		'LRCLIB',
		'Auto-transcribed',
		'From the video captions',
		'Pasted by hand',
		'No external IP',
		'Set the party address',
		'This TV needs one tap',
		'that track would not play'
	];
	const hits = tv.flatMap(({ f, text }) => retired.filter((s) => text.includes(s)).map((s) => `${f}: ${s}`));
	expect(hits).toEqual([]);
	// Non-vacuity: the census read the files the stage is drawn from.
	expect(tvFiles).toContain('src/lib/tv/JoinBadge.svelte');
});

test('the TV never names the key or the lyric source', () => {
	for (const { f, text } of tv) expect(text, f).not.toMatch(/soundingKey|provenanceLabel|ls-source/);
	// A key NAME typed in as a literal (`?? 'A minor'`) is the same regression by another road.
	const named = tv.filter(({ text }) => /\b[A-G][#b♯♭]? (major|minor)\b/.test(text)).map(({ f }) => f);
	expect(named).toEqual([]);
});

/*
 * STRUCTURE, NOT WORDING: an exact-string list stops only the words it lists, so a sub-line put back under new
 * words, or a reworded skip notice, walked past it. These hold the SHAPE: the deleted lines' classes stay deleted,
 * and the bad-file notice is the one line the spec gave it.
 */
test('the deleted notice lines stay deleted, whatever they would say', () => {
	// Every TV source, not just the page: `ls-source` was LyricsOverlay's line, and a notice can move into a component.
	for (const { f, text } of tv)
		for (const cls of ['ah-sub', 'ph-sub', 'ls-source']) expect(text, `${f}: ${cls}`).not.toContain(cls);
	const page = tv.find((t) => t.f === 'src/routes/tv/+page.svelte')!.text;
	expect(page).toContain("flashSkipNotice('That song won’t play')");
	expect(page.match(/flashSkipNotice\(/g)?.length, 'one definition + the two skip notices').toBe(3);
});

/*
 * THE TV STAYS ASCII FOR SIGNS (song-facts.ts's header): a typographic minus, arrow or accidental is a codepoint a
 * smart-TV browser's system fonts may not carry, and a missing glyph is a tofu box. `’`, `—`, `·`, `…` and `●` are
 * allowed — main's TV has always shipped them — and NOTHING ELSE outside ASCII is: a list of banned blocks missed
 * the next block over (`➜`). An HTML entity (`&rarr;`), a JS `\u` or `\x` escape, or a CSS escape (`"\2192"`) is
 * the same codepoint spelled in ASCII, so it is refused too. Held two ways: every TV source as text, and the strings
 * the TV imports from outside `lib/tv` as the values they really render.
 *
 * The one escape allowed is `\u00a0`: the lower third and Up next join title and artist with `'\u00a0· '`, and an
 * NBSP is a space with no glyph to tofu. Only the escape, because a literal NBSP cannot be told from a space in
 * review.
 */
const NOT_TV_SAFE = /[^\t -~’—·…●]|&#?[a-z0-9]+;/iu;
const ESCAPE = /\\u(?!00a0)\{?[0-9a-f]{4}|\\x[89a-f][0-9a-f]/i;
// A CSS escape is `\` plus 1-6 hex digits; one above U+007F draws a non-ASCII glyph from a `content:` string.
const CSS_ESCAPE = /\\([0-9a-f]{1,6})/gi;
// Data, never drawn: the CJK punctuation ranges the lyric line-joiner matches against.
const NOT_DRAWN = /^\s*const CJK_JOINS = /;

test('no TV source draws a sign outside ASCII', () => {
	const hits = tv.flatMap(({ f, text }) =>
		text
			.split('\n')
			// A TRAILING line comment is prose too (`// no address yet → nothing to warn about`). `\s//\s` never
			// matches a URL, whose `//` follows a colon.
			.map((line) => line.replace(/\s\/\/\s.*$/, ''))
			.filter((line) => !NOT_DRAWN.test(line) && (NOT_TV_SAFE.test(line) || ESCAPE.test(line)))
			.map((line) => `${f}: ${line.trim()}`)
	);
	expect(hits).toEqual([]);
});

test('no TV style block spells a non-ASCII glyph as a CSS escape', () => {
	const hits = tv.flatMap(({ f, text }) =>
		[...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].flatMap(([, css]) =>
			[...css!.matchAll(CSS_ESCAPE)].filter(([, hex]) => parseInt(hex!, 16) > 0x7f).map(([esc]) => `${f}: ${esc}`)
		)
	);
	expect(hits).toEqual([]);
	// Non-vacuity: the census reached a style block.
	expect(tv.find((t) => t.f === 'src/lib/tv/TvProgress.svelte')!.text).toContain('<style>');
});

const STATUSES = Object.keys({
	queued: 1,
	downloading: 1,
	separating: 1,
	aligning: 1,
	ready: 1,
	failed: 1,
	canceled: 1
} satisfies Record<MediaStatus, 1>) as MediaStatus[];

test('every TV string built outside the TV sources is ASCII for signs too', () => {
	const rendered: string[] = [UNREACHABLE_JOIN, UNREACHABLE_JOIN_FIX, NOW_SINGING, UP_NEXT];
	rendered.push(...PROCESS_STEPS, ...ATTRACT_PHRASES);
	for (const status of STATUSES) rendered.push(processStageLabel(status), processStageLabel(status, { pct: 40 }));
	for (let s = -12; s <= 12; s++) rendered.push(keyShiftLabel(s) ?? '');
	// The progress clocks: elapsed, and time left from a fresh song to the last second, past an hour too.
	for (const [at, of] of [
		[0, 8],
		[6, 8],
		[8, 8],
		[59, 3725]
	] as const)
		rendered.push(formatClock(at), formatRemainingAscii(at, of));
	expect(rendered.filter((s) => NOT_TV_SAFE.test(s))).toEqual([]);
	expect(keyShiftLabel(-2)).toBe('Key -2');
	expect(formatRemainingAscii(6, 8)).toBe('-0:02');
	expect(UNREACHABLE_JOIN_FIX).toBe('Fix it in Settings -> This machine');
	// The phone keeps its typographic minus; only the TV's form is ASCII.
	expect(formatRemaining(6, 8)).toBe('−0:02');
	// The TV reaches the phone's form nowhere: TvProgress draws time left through the ASCII form only.
	for (const { f, text } of tv) expect(text, f).not.toMatch(/\bformatRemaining\b/);
	expect(tv.find((t) => t.f === 'src/lib/tv/TvProgress.svelte')!.text).toContain('formatRemainingAscii(');
});

test('the room and machine settings speak guest words, and state the scope once, in the header', () => {
	for (const f of ['src/routes/settings/+page.svelte', 'src/routes/settings/server/+page.svelte']) {
		const page = strip(read(f));
		expect(page, f).not.toContain('<Card.Scope>');
		for (const old of ['>Rotation<', 'Kick out after', 'Grace period', 'Process quality', 'Quality ceiling', 'No cap'])
			expect(page, `${f}: ${old}`).not.toContain(old);
	}
	const room = strip(read('src/routes/settings/+page.svelte'));
	for (const now of ['>Turns<', 'Skip a quiet phone after', 'Guide ·', '>Quality<', 'Best available'])
		expect(room, now).toContain(now);
	// Quality lives IN the Sound card, so the page has exactly one "Sound" heading and no "Sound quality" twice.
	expect(room.match(/>Sound</g)?.length).toBe(1);
	expect(room).not.toContain('Sound quality');
	expect(room).not.toContain('id="quality"');
	// The Sound card ends at its OWN close, so a headless card slipped in after it does not count as inside it.
	const soundAt = room.indexOf('<Card.Root id="sound">');
	const sound = room.slice(soundAt, room.indexOf('</Card.Root>', soundAt));
	expect(sound).toContain('id="quality-ceiling"');
	expect(sound.match(/<Card\.(Root|Title)\b/g), 'one card, one heading').toEqual(['<Card.Root', '<Card.Title']);
	// The grace VALUE wraps as one piece, separator included: at 320 `1 hr 30 min` broke after its first word, and
	// then the `·` sat alone at the end of the first line.
	expect(room).toContain('<span class="value">· {graceLabel}</span>');
	expect(room).toMatch(/\.value \{\s*white-space: nowrap;/);
	expect(strip(read('src/lib/components/GuidingTrack.svelte'))).not.toContain('Guiding track');
});

test("the join notice renders only in JoinBadge's HERO branch, never on the corner card", () => {
	const badge = tv.find((t) => t.f === 'src/lib/tv/JoinBadge.svelte')!.text;
	const markup = badge.slice(badge.indexOf('</script>'), badge.indexOf('<style>'));
	const [corner, hero] = markup.split('{:else}');
	expect(corner).toContain("placement === 'corner'");
	expect(corner).not.toMatch(/badqr|unreachable/);
	expect(hero).toContain('class="badqr"');
});
