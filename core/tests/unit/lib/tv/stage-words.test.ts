import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { at, read } from '$test';
import { keyShiftLabel } from '$lib/song-facts';
import { UNREACHABLE_JOIN, UNREACHABLE_JOIN_FIX } from '$lib/tv/join-address';

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
	const page = tv.find((t) => t.f === 'src/routes/tv/+page.svelte')!.text;
	expect(page).not.toMatch(/soundingKey|provenanceLabel|ls-source/);
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
	const page = tv.find((t) => t.f === 'src/routes/tv/+page.svelte')!.text;
	for (const cls of ['ah-sub', 'ph-sub', 'ls-source']) expect(page, cls).not.toContain(cls);
	expect(page).toContain("flashSkipNotice('That song won’t play')");
	expect(page.match(/flashSkipNotice\(/g)?.length, 'one definition + the two skip notices').toBe(3);
});

/*
 * THE TV STAYS ASCII FOR SIGNS (song-facts.ts's header): a typographic minus, arrow or accidental is a codepoint a
 * smart-TV browser's system fonts may not carry, and a missing glyph is a tofu box. `’`, `—`, `·`, `…` and `●` are
 * allowed — main's TV has always shipped them. Held two ways: every TV source as text, and the strings the TV
 * imports from outside `lib/tv` as the values they really render.
 */
const TOFU = /[−±←-⇿⟰-⟿⤀-⥿♭-♯]/u;

test('no TV source draws a typographic minus, arrow or accidental', () => {
	const hits = tv.flatMap(({ f, text }) =>
		text
			.split('\n')
			// A TRAILING line comment is prose too (`// no address yet → nothing to warn about`). `\s//\s` never
			// matches a URL, whose `//` follows a colon.
			.map((line) => line.replace(/\s\/\/\s.*$/, ''))
			.filter((line) => TOFU.test(line))
			.map((line) => `${f}: ${line.trim()}`)
	);
	expect(hits).toEqual([]);
});

test('every TV string built outside the TV sources is ASCII for signs too', () => {
	const rendered = [UNREACHABLE_JOIN, UNREACHABLE_JOIN_FIX];
	for (let s = -12; s <= 12; s++) rendered.push(keyShiftLabel(s) ?? '');
	expect(rendered.filter((s) => TOFU.test(s))).toEqual([]);
	expect(keyShiftLabel(-2)).toBe('Key -2');
	expect(UNREACHABLE_JOIN_FIX).toBe('Fix it in Settings -> This machine');
});

test('the room and machine settings speak guest words, and state the scope once, in the header', () => {
	for (const f of ['src/routes/settings/+page.svelte', 'src/routes/settings/server/+page.svelte']) {
		const page = strip(read(f));
		expect(page, f).not.toContain('<Card.Scope>');
		for (const old of ['>Rotation<', 'Kick out after', 'Grace period', 'Process quality', 'Quality ceiling', 'No cap'])
			expect(page, `${f}: ${old}`).not.toContain(old);
	}
	const room = strip(read('src/routes/settings/+page.svelte'));
	for (const now of ['>Turns<', 'Skip a quiet phone after ·', 'Guide ·', '>Quality<', 'Best available'])
		expect(room, now).toContain(now);
	// Quality lives IN the Sound card, so the page has exactly one "Sound" heading and no "Sound quality" twice.
	expect(room.match(/>Sound</g)?.length).toBe(1);
	expect(room).not.toContain('Sound quality');
	expect(room).not.toContain('id="quality"');
	const sound = room.slice(room.indexOf('<Card.Root id="sound">'), room.indexOf('<Card.Root id="tv">'));
	expect(sound).toContain('id="quality-ceiling"');
	// The grace VALUE wraps as one piece: at 320 `1 hr 30 min` broke after its first word.
	expect(room).toContain('<span class="value">{graceLabel}</span>');
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
