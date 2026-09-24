// The unreachable-join notice, pinned so it stays a FOOTNOTE and never becomes a card again.
//
// The `.badqr*` class NAMES are deliberately kept on the notice — SEL.badQr and friends are how the e2e
// contract, the party flow and the scaling probe recognise this state — so a rename is a four-file change
// for no gain. See the markup note in JoinBadge.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { stripComments } from '@encore/test-support/scan';

const SRC = read('src/lib/tv/JoinBadge.svelte');

/** The declarations inside one scoped rule `.sel { ... }` (no nested braces in this file's rules). */
function ruleBody(css: string, sel: string): string {
	const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`);
	return re.exec(css)?.[1] ?? '';
}

const CSS = stripComments(SRC, { markup: true, keepLine: true });

test('the unroutable state never replaces the QR — both placements still render their image', () => {
	// Caught: standing in FOR the QR also took the typed path with it, because attract and the lobby
	// branched on reachability and rendered the alert alone — so the one screen still joinable by hand
	// showed neither the address nor the room code. Counted rather than matched: exactly one `<img>` per
	// placement. `{#if unreachable}` may still appear (it gates the notice) but never as the OUTER branch
	// of the template, which is what `{:else if placement` would mean.
	const imgs = SRC.match(/<img\s+src=\{qrDataUrl\}/g) ?? [];
	expect(imgs.length, 'hero and corner must each render the QR').toBe(2);
	expect(SRC, 'reachability must not be the outer branch — that is the card standing in for the QR').not.toMatch(
		/\{#if unreachable\}[\s\S]*\{:else if placement/
	);
	for (const caller of ['src/lib/tv/TvLobby.svelte', 'src/routes/tv/+page.svelte'])
		expect(read(caller), `${caller} must not swap its join block out on reachability`).not.toMatch(
			/\{#if\s+(?:join)?[uU]nreachable\}/
		);
});

test('the notice is a one-line footnote: no surface, no border, and no width cap of any kind', () => {
	const body = ruleBody(CSS, '.badqr');
	expect(body).not.toBe('');
	// A cap is the card coming back. `ch` is banned by name because it resolves against the element's own
	// font-size, which inherits 16px from :root — so a `ch` column freezes at ~346px while the TV type
	// scales around it on the vh/vmin --tv-* clamps. Any max-width is wrong now: the notice is one short
	// line and `text-wrap: balance` is what shapes it on a narrow 720p panel.
	expect(body, 'a width cap means this is a prose column again').not.toMatch(/max-width:/);
	expect(body).not.toMatch(/\bch\b/);
	for (const prop of ['background', 'border', 'box-shadow'])
		expect(body, `the notice must not paint a ${prop} — it is a footnote, not a panel`).not.toMatch(
			new RegExp(`${prop}:`)
		);
	// Sized from the smallest TV tier, so it cannot out-shout the QR it annotates.
	expect(body).toMatch(/font-size:\s*var\(--tv-label\)/);
	// One line, and the remedy clause is HIDDEN in the corner treatment rather than written twice, so one
	// string cannot drift from itself.
	expect(SRC).toContain('No external IP set');
	expect(ruleBody(CSS, '.corner .badqr-fix')).toMatch(/display:\s*none/);
});

test('the QR-treatment flex layout is scoped away from the unreachable notice', () => {
	// Caught: the notice reuses the `corner` class for its bottom-right pin, so an unscoped
	// `.corner { display:flex }` rowed the notice's block children and pushed the fix sentence outside the
	// card, where `.tv { overflow: hidden }` clipped it. No unscoped `.corner` rule may declare flex.
	const unscopedFlex = /\.corner(?!\s*:not\()(?![\w-])[^{}]*\{[^{}]*display:\s*flex[^{}]*\}/;
	expect(CSS).not.toMatch(unscopedFlex);
	const qrCorner = ruleBody(CSS, '.corner:not(.badqr)');
	expect(qrCorner).toMatch(/display:\s*flex/);
});

test('the notice declares no row layout, so its parts stay on one line rather than columns', () => {
	for (const sel of ['.badqr', '.corner .badqr']) {
		const disp = /display:\s*([^;]+);/.exec(ruleBody(CSS, sel))?.[1]?.trim() ?? '';
		if (disp) expect(disp, sel).not.toMatch(/flex|grid|inline-flex/);
	}
});

test("the card's prose parts stay retired, so the sentence cannot be reassembled inline", () => {
	// The failure shape was `<b>{shortUrl}</b>, which phones can't reach.` — the address inline, with the comma
	// orphaning onto the next line inside a two-word-wide column. The notice prints no address at all (attract
	// and the lobby print the real one below it), so reintroducing any part of that sentence reintroduces the
	// paragraph. Read comment-STRIPPED, because the component's own note names these three classes.
	const MARKUP = stripComments(SRC, { markup: true, keepLine: true });
	expect(MARKUP).not.toMatch(/<\/b>\s*,\s*which/);
	for (const gone of ['badqr-addr', 'badqr-lead', 'badqr-b"'])
		expect(MARKUP, `\`${gone}\` belongs to the retired card`).not.toContain(gone);
	expect(MARKUP).not.toMatch(/class="badqr"[\s\S]{0,400}\{shortUrl\}/);
});
