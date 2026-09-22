// The unreachable-join notice, pinned so it stays a FOOTNOTE and never becomes a card again.
//
// ── WHAT THIS FILE USED TO GUARD, AND WHY IT CHANGED (2026-09-21) ────────────────────────────────
//
// It guarded a `--danger` CARD that REPLACED the QR when the advertised join address was unroutable:
// a headline, a body paragraph carrying the address in a `<b>`, and a two-line fix instruction, capped
// at `clamp(320px, 44vmin, 720px)` and centred where the code should have been. Two shipped defects
// were pinned here and both were about that card's prose column:
//
//   1. `max-width: 34ch` resolved `ch` against the ELEMENT's own font-size, which inherits from :root
//      at 16px — so the card stayed ~346px on a 4K wall while the type inside scaled on the vh/vmin
//      --tv-* clamps. Prose forced into a QR square, roughly two words wide, and inside it the long
//      address filled its line and the trailing ", which phones can't reach." clause began a new line
//      with a leading comma.
//   2. `.corner`'s flex row (written for the QR-beside-text treatment) leaked onto the alert, which
//      reuses the `corner` class for its bottom-right pin, and rowed its three block children — pushing
//      the fix sentence outside the card where `.tv { overflow: hidden }` clipped it.
//
// THE CARD IS GONE. Reported as the localhost error being far too large: on a loopback address the only
// person looking is the operator, who does not need a quarter of a wall to be told what they did not
// configure. The QR now renders NORMALLY in every state and the fault is one line beside it — which
// deletes both defects by construction rather than by constraint, since there is no prose column left
// to cap and no block children left to row.
//
// SO THE ARMS INVERTED. They no longer pin how the card wraps; they pin that it is not a card:
//   1. The QR is never replaced — both hero and corner render their image in every state.
//   2. The notice is one line at the smallest TV tier, with no surface, no border and no width cap (any
//      of which is the card coming back — and a `ch` cap is specifically banned, since that is the trap
//      arm 1 above was written for).
//   3. The `.corner` flex row stays scoped `:not(.badqr)`, unchanged: the notice still reuses `corner`.
//   4. The retired prose parts stay retired, so the sentence cannot be reassembled inline.
//
// The `.badqr*` class NAMES are deliberately kept on the notice — SEL.badQr and friends are how the e2e
// contract, the party flow and the scaling probe recognise this state — so a rename is a four-file change
// for no gain. See the markup note in JoinBadge.
//
// No DOM in bun test (see contract.test.ts) — this is a source scan over the component's own CSS/markup.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const SRC = read('src/lib/tv/JoinBadge.svelte');

/** Blank comments so a commented-out declaration cannot satisfy an assertion. */
function stripComments(s: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return s.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

/** The declarations inside one scoped rule `.sel { ... }` (no nested braces in this file's rules). */
function ruleBody(css: string, sel: string): string {
	const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`);
	return re.exec(css)?.[1] ?? '';
}

const CSS = stripComments(SRC);

test('the unroutable state never replaces the QR — both placements still render their image', () => {
	/*
	 * THE ARM THE WHOLE CHANGE RESTS ON. The card's defining behaviour was standing in FOR the QR, which
	 * also took the typed path with it: attract and the lobby branched on reachability and rendered the
	 * alert alone, so the one screen still joinable by hand showed neither the address nor the room code.
	 *
	 * Counted rather than merely matched: exactly one `<img>` per placement, and no branch left in this
	 * component that could swap one out. `{#if unreachable}` may still appear — it gates the notice — but
	 * never as the outer branch of the whole template, which is what `{:else if placement` would mean.
	 */
	const imgs = SRC.match(/<img\s+src=\{qrDataUrl\}/g) ?? [];
	expect(imgs.length, 'hero and corner must each render the QR').toBe(2);
	expect(SRC, 'reachability must not be the outer branch — that is the card standing in for the QR').not.toMatch(
		/\{#if unreachable\}[\s\S]*\{:else if placement/
	);
	// …and the callers must not branch on it either, for the same reason: that is where the typed path was lost.
	for (const caller of ['src/lib/tv/TvLobby.svelte', 'src/routes/tv/+page.svelte'])
		expect(read(caller), `${caller} must not swap its join block out on reachability`).not.toMatch(
			/\{#if\s+(?:join)?[uU]nreachable\}/
		);
});

test('the notice is a one-line footnote: no surface, no border, and no width cap of any kind', () => {
	const body = ruleBody(CSS, '.badqr');
	expect(body).not.toBe('');
	/*
	 * A CAP IS THE CARD COMING BACK. `ch` is called out by name because that is the exact trap the old arm
	 * existed for — `ch` resolves against the element's own font-size, which inherits 16px from :root, so a
	 * `ch` column freezes while the TV type scales around it. But ANY max-width here is wrong now: the
	 * notice is one short line and `text-wrap: balance` is what shapes it on a narrow 720p panel, with no
	 * second axis to keep in step with the type scale.
	 */
	expect(body, 'a width cap means this is a prose column again').not.toMatch(/max-width:/);
	expect(body).not.toMatch(/\bch\b/);
	// No card chrome: a fill, a border or a shadow here is the --danger panel returning.
	for (const prop of ['background', 'border', 'box-shadow'])
		expect(body, `the notice must not paint a ${prop} — it is a footnote, not a panel`).not.toMatch(
			new RegExp(`${prop}:`)
		);
	// Sized from the smallest TV tier, so it cannot out-shout the QR it annotates.
	expect(body).toMatch(/font-size:\s*var\(--tv-label\)/);
	// And it says what it says in one line. The remedy clause is hidden in the corner treatment rather than
	// written twice, so one string cannot drift from itself.
	expect(SRC).toContain('No external IP set');
	expect(ruleBody(CSS, '.corner .badqr-fix')).toMatch(/display:\s*none/);
});

// The CORNER placement, the one that renders mid-song while somebody is singing. This arm is UNCHANGED in
// substance: the notice still reuses the `corner` class for its bottom-right pin, so the QR treatment's
// flex row must still be scoped away from it. Defect 2 in the header note is what it maps to.
test('the QR-treatment flex layout is scoped away from the unreachable notice', () => {
	// LOAD-BEARING: no `.corner` rule that is NOT scoped `:not(.badqr)` may declare flex — an unscoped
	// `.corner { display:flex }` is exactly what leaked the row layout onto the notice.
	const unscopedFlex = /\.corner(?!\s*:not\()(?![\w-])[^{}]*\{[^{}]*display:\s*flex[^{}]*\}/;
	expect(CSS).not.toMatch(unscopedFlex);
	// And the scoped QR rule must still carry the flex row it needs for the QR-beside-text treatment.
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
	/*
	 * The failure shape was `<b>{shortUrl}</b>, which phones can't reach.` — the address inline, a comma
	 * immediately after the closing tag, orphaning onto the next line inside a two-word-wide column.
	 *
	 * All three parts of that sentence are gone with the card, and each is pinned absent rather than just
	 * the comma shape: the notice does not print an address at all (attract and the lobby print the REAL
	 * one directly below it), so reintroducing any of these means reintroducing the paragraph.
	 */
	// Read off the comment-STRIPPED source: the component's own note names these three classes to record
	// what retired with the card, and a raw scan would red on the prose that explains the deletion.
	const MARKUP = stripComments(SRC);
	expect(MARKUP).not.toMatch(/<\/b>\s*,\s*which/);
	for (const gone of ['badqr-addr', 'badqr-lead', 'badqr-b"'])
		expect(MARKUP, `\`${gone}\` belongs to the retired card`).not.toContain(gone);
	// The address itself: `shortUrl` is the corner card's caption line, never the notice's subject.
	expect(MARKUP).not.toMatch(/class="badqr"[\s\S]{0,400}\{shortUrl\}/);
});
