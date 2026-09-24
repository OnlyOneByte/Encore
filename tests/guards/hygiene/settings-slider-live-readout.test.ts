// guard: every Settings range slider must update its on-screen readout LIVE during a drag. Caught all eight range
// inputs wired with `onchange` only: the readout is a function of `settings`, which only moved on `change` —
// fired on RELEASE — so the label held the pre-drag number for the whole drag and a value could not be chosen by
// sight; every guess was also a committed write broadcast room-wide. The split follows GuidingTrack /
// ColourPicker: a live handler moves ONE room field on screen with no network write, the commit handler writes.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const PAGE = 'src/routes/settings/+page.svelte';

// Blank comments, preserving newlines, so a commented-out live handler does NOT count as wired.
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/./g, ' '));
}

// Each Settings range slider: its element id and the RoomSettings field its live handler must set.
// guideLevelDefault's input value is a percent while its field is a 0..1 fraction, so its handler divides by 100.
const SLIDERS: { id: string; field: string; div100?: boolean }[] = [
	{ id: 'presence-grace', field: 'presenceGraceMinutes' },
	{ id: 'song-intro-ms', field: 'songIntroMs' },
	{ id: 'lyrics-scale', field: 'lyricsScalePct' },
	{ id: 'lyrics-lead', field: 'lyricsLeadMs' },
	{ id: 'lyrics-before', field: 'lyricsLinesBefore' },
	{ id: 'lyrics-after', field: 'lyricsLinesAfter' },
	{ id: 'guide-default', field: 'guideLevelDefault', div100: true }
];

// The stage colour is a `type="color"` input, not a range, but it stays here: a native colour picker fires `input`
// continuously while the user drags inside it, so the live/commit split still applies.
const COLOUR_INPUTS: { id: string; field: string }[] = [{ id: 'tv-background-color', field: 'tvBackgroundColor' }];

// The element carrying a given id, across newlines. Matches <Slider> as well as <input>: the seven range sliders
// are <Slider>, while the stage-colour control is still a native <input type="color">.
function controlElement(src: string, id: string): string {
	const m = src.match(new RegExp(`<(?:input|Slider)\\b[\\s\\S]*?id="${id}"[\\s\\S]*?/>`));
	expect(m, `expected an <input|Slider id="${id}"> element in settings/+page.svelte`).not.toBeNull();
	return m![0];
}

const raw = read(PAGE);
const src = stripComments(raw);

for (const { id, field, div100 } of SLIDERS) {
	test(`the ${id} slider updates its readout live via liveRoom('${field}')`, () => {
		const el = controlElement(src, id);
		// The CONTRACT is live while dragging, commit on release; on Bits UI that spells `onValueChange` /
		// `onValueCommit`, and the commit path must stay or a drag never writes.
		const live = new RegExp(`onValueChange=\\{\\(v\\)\\s*=>\\s*liveRoom\\(\\s*'${field}'\\s*,[\\s\\S]*?\\)\\s*\\}`);
		expect(
			live.test(el),
			`#${id} has no onValueChange={(v) => liveRoom('${field}', …)} — its readout will hold the pre-drag ` +
				`value for the whole drag. Add the live handler beside its onValueCommit commit.`
		).toBe(true);
		if (div100) {
			// The guide field is a 0..1 fraction; its live handler must divide by 100 or the readout jumps 100x mid-drag.
			expect(
				/liveRoom\(\s*'guideLevelDefault'\s*,\s*v\s*\/\s*100\s*\)/.test(el),
				`#guide-default's liveRoom must divide the percent value by 100 to match its onValueCommit commit`
			).toBe(true);
		}
		expect(
			new RegExp(`onValueCommit=\\{\\(v\\)\\s*=>\\s*onroom\\(\\{\\s*${field}:`).test(el),
			`#${id} must keep its onchange={(e) => onroom({ ${field}: … })} commit alongside the live handler`
		).toBe(true);
	});
}

for (const { id, field } of COLOUR_INPUTS) {
	test(`the ${id} colour input updates its swatch live via liveRoom('${field}')`, () => {
		const el = controlElement(src, id);
		// It must actually BE a colour input, not a range carrying this id, and its value IS the field's value, so
		// unlike the sliders there is no Number() coercion.
		expect(/type="color"/.test(el), `#${id} must be an <input type="color">, not a range`).toBe(true);
		const live = new RegExp(`oninput=\\{\\(e\\)\\s*=>\\s*liveRoom\\(\\s*'${field}'\\s*,[\\s\\S]*?\\)\\s*\\}`);
		expect(
			live.test(el),
			`#${id} has no oninput={(e) => liveRoom('${field}', …)} — its swatch will hold the previous ` +
				`colour for the whole drag inside the picker.`
		).toBe(true);
		expect(
			new RegExp(`onchange=\\{\\(e\\)\\s*=>\\s*onroom\\(\\{\\s*${field}:`).test(el),
			`#${id} must keep its onchange={(e) => onroom({ ${field}: … })} commit alongside the live handler`
		).toBe(true);
	});
}

test('liveRoom moves a room field on screen without a network write', () => {
	// A local optimistic update of settings.room only — no fetch/patch/onroom inside it.
	expect(
		/function liveRoom<[\s\S]*?>\([\s\S]*?\)\s*\{[\s\S]*?settings\s*=\s*\{\s*\.\.\.settings,\s*room:\s*\{\s*\.\.\.settings\.room,\s*\[field\]:\s*value\s*\}\s*\}[\s\S]*?\}/.test(
			src
		),
		'liveRoom must locally spread settings.room with the one changed field and issue no write'
	).toBe(true);
});

test('a rejected commit rolls back to the server-confirmed value, not the dragged one', () => {
	// Because liveRoom moves `settings` every drag frame, patch() must snapshot `committed` — which advances only on a
	// confirmed response or a load re-adopt — never `settings`, the dragged value the server refused.
	expect(
		/async function patch\([\s\S]*?const before = committed;/.test(src),
		"patch()'s rollback baseline must be `committed` (the server-confirmed value), not `settings` — " +
			'otherwise a drag frame becomes the value a rejected commit reverts to'
	).toBe(true);
	expect(
		/if \(!res\.ok\) throw new Error\('rejected'\);\s*settings = await res\.json\(\);\s*committed = settings;/.test(
			src
		),
		'committed must be set to the server response on a successful commit'
	).toBe(true);
	expect(
		/\$effect\(\(\) => \{\s*settings = data\.settings;\s*committed = data\.settings;\s*\}\)/.test(src),
		'the load effect must refresh committed alongside settings'
	).toBe(true);
});
