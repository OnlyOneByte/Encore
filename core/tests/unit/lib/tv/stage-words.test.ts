import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { at, read } from '$test';

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
});

test('the room and machine settings speak guest words, and state the scope once, in the header', () => {
	for (const f of ['src/routes/settings/+page.svelte', 'src/routes/settings/server/+page.svelte']) {
		const page = strip(read(f));
		expect(page, f).not.toContain('<Card.Scope>');
		for (const old of ['>Rotation<', 'Kick out after', 'Grace period', 'Process quality', 'Quality ceiling', 'No cap'])
			expect(page, `${f}: ${old}`).not.toContain(old);
	}
	const room = strip(read('src/routes/settings/+page.svelte'));
	for (const now of ['>Turns<', 'Skip a quiet phone after ·', 'Guide ·', '>Sound quality<', 'Best available'])
		expect(room, now).toContain(now);
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
