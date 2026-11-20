import { expect, test } from 'bun:test';
import { read } from '$test';
import { NOW_SINGING, UP_NEXT, YOURE_UP } from '$lib/phrasing/turn-phrasing';

/*
 * guard: whose turn it is has ONE wording (UI-12). The TV's intro card said "Next up", its loading card "Up next" or
 * "Loading" for the CURRENT singer, and /queue "Singing now" under an "Up next" title. Each surface now reads
 * `turn-phrasing`, so a literal copy of any of those labels in their markup is the drift coming back. Comments are
 * stripped first: the prose quotes the old labels.
 */
function strip(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '');
}

const SURFACES = ['src/routes/tv/+page.svelte', 'src/routes/queue/+page.svelte', 'src/lib/components/YoureUp.svelte'];

test('the turn labels are spelled once, in turn-phrasing', () => {
	expect(NOW_SINGING).toBe('Now singing');
	expect(UP_NEXT).toBe('Up next');
	expect(YOURE_UP).toBe('You’re up');
	for (const path of SURFACES) {
		const body = strip(read(path));
		expect(body).toContain("from '$lib/phrasing/turn-phrasing'");
		for (const literal of [/Now singing/, /Singing now/, /Up next/, /Next up/, /You.re up/, />\s*Loading\s*</]) {
			expect({ path, hit: literal.test(body) }).toEqual({ path, hit: false });
		}
	}
});

test('the phone tab is titled for what it holds', () => {
	expect(read('src/routes/queue/+page.svelte')).toContain('<PageHeader title="Queue"');
});
