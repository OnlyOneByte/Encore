// guard: every Settings range slider must update its on-screen readout LIVE during a drag.
//
// THE DEFECT. All eight range inputs in +page.svelte were wired with `onchange` only. Their
// readout label is a function of `settings`, and `settings` only moved inside patch() on the `change`
// event — which fires on RELEASE. So the label held the pre-drag number for the whole drag and a value
// could not be chosen by sight; every guess was also a committed write broadcast room-wide. The in-repo
// precedents (GuidingTrack.svelte, ColourPicker.svelte) already split oninput (live display) from
// onchange (commit); this brings the eight Settings sliders to the same idiom via a liveRoom() helper
// that moves ONE room field on screen with no network write.
//
// WHY A SOURCE SCAN. The wiring (an `oninput` on each range, plus a rollback baseline that is not the
// dragged value) is a property of the component source, decidable without rendering. The guard reads
// +page.svelte, strips comments so a commented-out handler cannot satisfy it, and pins each slider's
// live handler individually so a single reverted oninput reds exactly one named test.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE = join(import.meta.dir, '+page.svelte');

// Blank /* */, <!-- -->, and // line comments, preserving newlines so line-based reasoning holds and a
// commented-out oninput does NOT count as wired. Deliberately does not touch string contents; the
// handlers we scan for contain no comment tokens.
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/./g, ' '));
}

// Each Settings range slider: its element id and the RoomSettings field its live handler must set.
// guideLevelDefault is the one whose input value is a percent and whose field is a 0..1 fraction, so
// its live handler divides by 100 exactly as the commit does.
const SLIDERS: { id: string; field: string; div100?: boolean }[] = [
	{ id: 'presence-grace', field: 'presenceGraceMinutes' },
	{ id: 'song-intro-ms', field: 'songIntroMs' },
	{ id: 'lyrics-scale', field: 'lyricsScalePct' },
	{ id: 'lyrics-lead', field: 'lyricsLeadMs' },
	{ id: 'lyrics-before', field: 'lyricsLinesBefore' },
	{ id: 'lyrics-after', field: 'lyricsLinesAfter' },
	{ id: 'guide-default', field: 'guideLevelDefault', div100: true }
];

// The stage colour was `tv-background-hue`, a range, until the full-picker rewrite replaced the stored angle with a real
// colour. It is a `type="color"` now, so it moved out of SLIDERS — but it did NOT leave this guard, and
// that is deliberate: a native colour picker fires `input` continuously while the user drags inside it,
// so the live/commit split this guard exists for applies unchanged. Deleting the entry instead of moving it
// would have quietly dropped the one control on this page whose live readout is a visible swatch.
const COLOUR_INPUTS: { id: string; field: string }[] = [{ id: 'tv-background-color', field: 'tvBackgroundColor' }];

/*
 * The element carrying a given id, across newlines. Self-closing.
 *
 * S3: matches <Slider> as well as <input>. The seven range sliders are <Slider> now, while the
 * stage-colour control below is still a native <input type="color"> — the registry has no colour
 * primitive — so this guard spans both spellings on purpose.
 */
function controlElement(src: string, id: string): string {
	const m = src.match(new RegExp(`<(?:input|Slider)\\b[\\s\\S]*?id="${id}"[\\s\\S]*?/>`));
	expect(m, `expected an <input|Slider id="${id}"> element in settings/+page.svelte`).not.toBeNull();
	return m![0];
}

const raw = readFileSync(PAGE, 'utf8');
const src = stripComments(raw);

for (const { id, field, div100 } of SLIDERS) {
	test(`the ${id} slider updates its readout live via liveRoom('${field}')`, () => {
		const el = controlElement(src, id);
		/*
		 * S3: the CONTRACT is unchanged — live while dragging, commit on release — but its spelling
		 * followed the control onto Bits UI: `oninput` → `onValueChange`, `onchange` → `onValueCommit`,
		 * and the handler takes the value directly instead of digging it out of a DOM event. Bits UI
		 * provides both edges as first-class props, which is what made the swap safe: had it offered
		 * only a change event, the live/commit split would have had to be rebuilt by hand.
		 */
		const live = new RegExp(`onValueChange=\\{\\(v\\)\\s*=>\\s*liveRoom\\(\\s*'${field}'\\s*,[\\s\\S]*?\\)\\s*\\}`);
		expect(
			live.test(el),
			`#${id} has no onValueChange={(v) => liveRoom('${field}', …)} — its readout will hold the pre-drag ` +
				`value for the whole drag. Add the live handler beside its onValueCommit commit.`
		).toBe(true);
		if (div100) {
			// The guide slider's field is a 0..1 fraction; the live handler must divide by 100 to match
			// the onchange commit, or the readout would jump 100x mid-drag.
			expect(
				/liveRoom\(\s*'guideLevelDefault'\s*,\s*v\s*\/\s*100\s*\)/.test(el),
				`#guide-default's liveRoom must divide the percent value by 100 to match its onValueCommit commit`
			).toBe(true);
		}
		// The commit path stays: onValueCommit still calls onroom for this field, so a drag still writes
		// on release. This keeps the fix from silently dropping the commit while adding the live handler.
		expect(
			new RegExp(`onValueCommit=\\{\\(v\\)\\s*=>\\s*onroom\\(\\{\\s*${field}:`).test(el),
			`#${id} must keep its onchange={(e) => onroom({ ${field}: … })} commit alongside the live handler`
		).toBe(true);
	});
}

for (const { id, field } of COLOUR_INPUTS) {
	test(`the ${id} colour input updates its swatch live via liveRoom('${field}')`, () => {
		const el = controlElement(src, id);
		// It must actually be a colour input, not a range that happens to carry this id — the whole point
		// of that rewrite is that the control widened from one axis to a full picker.
		expect(/type="color"/.test(el), `#${id} must be an <input type="color">, not a range`).toBe(true);
		// A colour input's value IS the field's value, so unlike the sliders there is no Number() coercion.
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
	// A local optimistic update of settings.room only — no fetch/patch/onroom inside it. Its body is
	// exactly the room-scope spread patch() applies optimistically, minus the commit.
	expect(
		/function liveRoom<[\s\S]*?>\([\s\S]*?\)\s*\{[\s\S]*?settings\s*=\s*\{\s*\.\.\.settings,\s*room:\s*\{\s*\.\.\.settings\.room,\s*\[field\]:\s*value\s*\}\s*\}[\s\S]*?\}/.test(
			src
		),
		'liveRoom must locally spread settings.room with the one changed field and issue no write'
	).toBe(true);
});

test('a rejected commit rolls back to the server-confirmed value, not the dragged one', () => {
	// Because liveRoom moves `settings` on every drag frame, patch() must NOT snapshot `settings` as its
	// rollback baseline — that would be the dragged value the server refused. It snapshots `committed`,
	// which only advances on a confirmed response or a load. This is what makes the oninput split safe.
	expect(
		/async function patch\([\s\S]*?const before = committed;/.test(src),
		"patch()'s rollback baseline must be `committed` (the server-confirmed value), not `settings` — " +
			'otherwise a drag frame becomes the value a rejected commit reverts to'
	).toBe(true);
	// committed advances only on a confirmed response …
	expect(
		/if \(!res\.ok\) throw new Error\('rejected'\);\s*settings = await res\.json\(\);\s*committed = settings;/.test(
			src
		),
		'committed must be set to the server response on a successful commit'
	).toBe(true);
	// … and on a load re-adopt, so an external write moves the rollback baseline too.
	expect(
		/\$effect\(\(\) => \{\s*settings = data\.settings;\s*committed = data\.settings;\s*\}\)/.test(src),
		'the load effect must refresh committed alongside settings'
	).toBe(true);
});
