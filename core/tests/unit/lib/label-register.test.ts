import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { at, read } from '$test';

/*
 * guard: a field label has ONE dress and ONE wording rule.
 *
 * THE DRESS. `app.css`'s `.control-label` and ui/field's `[data-slot='field-label']` render the same thing
 * (`--ph-text-md`, weight 500, sentence case, `--ink-dim`). `GuidingTrack` used to put an uppercase 0.1em
 * `--ph-text-xs` span — the SECTION register, `.grouphead`'s dress — INSIDE a real `[data-slot='field-label']`,
 * so a field label wore a heading's letterforms. Neither of its hosts (the drawer, `/components`) renders a second
 * field label, so nothing on screen contradicted it; the element it sat in is the whole evidence, which is why the
 * first test reads the MARKUP. The eyebrow is gone; the two `--ph-text-xs`/0.1em rows that survive label no control.
 *
 * THE WORDING. Second person exactly when the value is the singer's OWN (`Your name`, `Your color`); a bare noun
 * for anything the room or the box owns. `/settings` passed `label="Color"` while the join screen passed
 * `label="Your color"` and `ColourRing` DEFAULTED to `Your color` — one control under two names on two screens,
 * with nothing recording which was canonical.
 *
 * Both halves are cheap to undo by accident from inside one component, which is what this file is for. Sources
 * are read as TEXT with comments stripped first: the prose in these files quotes both dresses and every label
 * string, so a census that counts comments counts the argument about the rule as instances of it.
 */

/** Comments out. An HTML comment in markup and a block comment in `<script>`/`<style>` both quote label copy. */
function strip(source: string): string {
	return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const guidingTrack = strip(read('src/lib/components/GuidingTrack.svelte'));
const settings = strip(read('src/routes/settings/+page.svelte'));
const joinLanding = strip(read('src/lib/components/JoinLanding.svelte'));
const colourRing = strip(read('src/lib/components/ColourRing.svelte'));
const codeEntry = strip(read('src/lib/components/CodeEntry.svelte'));

/** The text a `<Field.Label>` renders, tags and whitespace flattened. Interpolations are left spelled as written:
 *  `Kick out after · {graceLabel}` is one label whose tail is a value, not a second label. */
function fieldLabelTexts(source: string): string[] {
	return [...source.matchAll(/<Field\.Label[^>]*>([\s\S]*?)<\/Field\.Label\s*>/g)]
		.map((m) =>
			m[1]!
				.replace(/<[^>]*>/g, '')
				.replace(/\s+/g, ' ')
				.trim()
		)
		.filter((text) => text !== '{label}'); // the `selectField` snippet's own hole, counted through its callers
}

/** The label argument of every `{@render selectField(id, label, …)}` — the second quoted string in the call. */
function selectFieldLabels(source: string): string[] {
	return [...source.matchAll(/@render selectField\(([\s\S]{0,300}?)\)/g)].map(
		(m) => [...m[1]!.matchAll(/'([^']*)'/g)].map((q) => q[1]!)[1]!
	);
}

test("GuidingTrack's rail label wears the field primitive's own dress, with no eyebrow inside it", () => {
	// The label's TEXT is a bare child of the primitive — no span, so nothing can override the dress.
	expect(guidingTrack).toMatch(
		/<Field\.Label data-inline for="guiding-track">\s*Guiding track\s*<span class="gt-val">/
	);
	// The section register's two properties are absent from the whole file, not merely from that row.
	expect(guidingTrack).not.toMatch(/text-transform|letter-spacing|class="lab"/);

	// ONE RUNG for the row: the value matches the rung `label.svelte` sets, so the label cannot outsize the reading
	// it labels (the objection the retired comment raised, and the reason the fix moved the VALUE up).
	expect(guidingTrack).toMatch(/\.gt-val \{[^}]*font-size: var\(--ph-text-md\);/);
	expect(read('src/lib/components/ui/label/label.svelte')).toContain('text-[length:var(--ph-text-md)]');
	expect(read('src/lib/components/ui/label/label.svelte')).toContain('font-medium');
	// `.gt-val` is `SEL.guideReadout`; a rename here silently unhooks p16's level reading.
	expect(read('tests/playwright/world/selectors.ts')).toContain("guideReadout: '.gt-val'");

	// WHY THE MARKUP IS THE EVIDENCE: this row's two hosts show no other field label, so a screen comparison — the
	// thing that caught the You card — was never available here. app.css and docs/FRONTEND.md both say so.
	for (const host of ['src/routes/components/+page.svelte', 'src/lib/components/NowPlayingDrawer.svelte']) {
		expect(strip(read(host))).not.toMatch(/<Field\.Label|class="control-label"|<ColourRing|<CodeEntry/);
	}
});

test('exactly two `--ph-text-xs`/0.1em label rows survive, and neither labels a control', () => {
	const onPhLadder: string[] = [];
	const onTvLadder: string[] = [];
	for (const rel of readdirSync(at('src'), { recursive: true, encoding: 'utf8' })) {
		if (!/\.(css|svelte)$/.test(rel)) continue;
		for (const rule of strip(readFileSync(at('src', rel), 'utf8')).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
			if (!/letter-spacing:\s*0\.1em/.test(rule[2]!)) continue;
			const selector = rule[1]!.trim().split('\n').pop()!.trim();
			(/var\(--ph-text-/.test(rule[2]!) ? onPhLadder : onTvLadder).push(`${rel} ${selector}`);
		}
	}
	// The exact pair docs/FRONTEND.md and app.css's `.control-label` both name. A third would mean the eyebrow
	// came back on a phone surface.
	expect(onPhLadder.sort()).toEqual([
		'lib/components/NowPlayingDrawer.svelte .key .lab',
		'routes/song/[mediaId]/+page.svelte .lab'
	]);
	// The television's are a different ladder entirely, which is why the claim above is scoped to `--ph-text-*`.
	expect(onTvLadder.sort()).toEqual(['lib/tv/TvProgress.svelte .pill .lab', 'routes/tv/+page.svelte .phrase-kick']);

	// Neither host renders a field label at all, so neither row can be one wearing the wrong register.
	for (const rel of ['src/lib/components/NowPlayingDrawer.svelte', 'src/routes/song/[mediaId]/+page.svelte']) {
		const host = strip(read(rel));
		expect(host).not.toMatch(/<Field\.Label|class="control-label"/);
	}
});

test("the second person marks the singer's own two values, on both surfaces that edit them", () => {
	// `/settings`' You card, which was the divergent site on both strings.
	expect(settings).toContain('<Field.Label for="profile-name">Your name</Field.Label>');
	expect(settings).toMatch(/<ColourRing[\s\S]{0,80}label="Your color"/);
	// The join screen's identity pane, which already read this way.
	expect(joinLanding).toContain('<span class="control-label">Your name</span>');
	expect(joinLanding).toMatch(/<ColourRing[\s\S]{0,80}label="Your color"/);
	// The component default IS the rule, so a new caller that passes nothing lands on it.
	expect(colourRing).toMatch(/label = 'Your color'/);

	// And nothing the ROOM or the box owns takes it — including the same knob's room-scope label.
	const roomOrBox = [...fieldLabelTexts(settings), ...selectFieldLabels(settings), ...fieldLabelTexts(guidingTrack)]
		.filter((text) => text !== 'Your name')
		.filter((text) => /^Your\b/.test(text));
	expect(roomOrBox).toEqual([]);
	expect(codeEntry).toMatch(/label = 'Room code'/);
});

test('the field-label census is 33: 4 possessive, 29 bare', () => {
	// Every label the app renders through either carrier, counted where it is WRITTEN.
	const census = [
		...fieldLabelTexts(settings), // 14 spelled inline on /settings
		...selectFieldLabels(settings), // 14 more through its `selectField` snippet
		...fieldLabelTexts(guidingTrack), // the rail label, now the primitive's own text
		'Your name', // JoinLanding's `.control-label` over its wrapped Input
		'Room code', // CodeEntry's `.control-label`, its one call site passing the default's own wording
		'Your color', // ColourRing on /settings
		'Your color' // ColourRing on the join screen
	];
	expect(census).toHaveLength(33);

	const possessive = census.filter((text) => /^Your\b/.test(text));
	// Two values × two surfaces. The count is quoted in docs/FRONTEND.md; it moves only when a surface that edits
	// the singer's own name or colour is added or removed.
	expect(possessive).toEqual(['Your name', 'Your name', 'Your color', 'Your color']);
	expect(census.length - possessive.length).toBe(29);
});
