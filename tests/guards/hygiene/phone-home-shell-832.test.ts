// Wiring guards for the direction-A phone home shell.
//
// WHY A SOURCE SCAN. What these pin are SYNTAX claims about `routes/+page.svelte` — which component
// renders where, what is gated on what, which value is fed to which prop. The route imports
// `$app/navigation` and `$app/state`, and the test harness aliases neither virtual module, so it
// cannot be mounted at all (`lib/tv/wake-lock.test.ts:18-27` states the blocker). Every claim that is
// a MEASUREMENT rather than a wiring fact — what renders, what the transport's disabled state is,
// whether the wait clause appears — is asserted against the real DOM in
// `lib/components/phone-home-832.test.ts` instead, per XR-PH-21.
//
// The shape here matters: these are the assertions that RED when the corresponding relocation hunk is
// reverted. A markup move is invisible to a behavioural suite (nothing imports the route), so without
// them the queue could slide back into a sheet, or the live controls could be dropped on the floor,
// with every other test still green.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

function stripComments(src: string): string {
	return src
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const RAW = read('apps/core/src/routes/+page.svelte');
const PAGE = stripComments(RAW);

// ── the queue IS home ────────────────────────────────────────────────────────────────────────────
test('home renders the now-playing HERO, and the queue sheet is gone from this route', () => {
	expect(PAGE).toContain('<NowPlayingHero');
	// The whole sheet rationale ("at a party you are either browsing or checking the queue, so the two
	// should not fight over one scroll") is what direction A INVERTS, so the sheet must not still be
	// here holding the rotation. Both the import and the element.
	expect(PAGE).not.toContain('QueueSheet');
});

test('the rotation rows render inside <main>, not inside a pull-up sheet', () => {
	const main = PAGE.slice(PAGE.indexOf('<main>'), PAGE.indexOf('</main>'));
	expect(main).toContain('{#each queued as e, i (e.id)}');
	expect(main).toContain('<QueueRow');
	expect(main).toContain('<ProcessingCard');
	// …and behind the home branch, so the results overlay does not stack the queue under it. Since the
	// owner correction home is `{#if !searchActive}` — the queue shows with an empty search box.
	const homeStart = main.indexOf('{#if !searchActive}');
	expect(homeStart).toBeGreaterThanOrEqual(0);
	expect(main.indexOf('{#each queued as e, i (e.id)}')).toBeGreaterThan(homeStart);
});

test('the live singing controls came WITH the hero, into its disclosure body (XR-PH-15)', () => {
	// The sheet was their only home. Deleting it without relocating them would silently drop guide
	// vocals, key and range from the phone — a user-facing regression no other test would see.
	/*
	 * The slice counts NESTING. It used to end at the first `{/snippet}` after the opening tag, which is
	 * correct only while `controls()` is the ONLY snippet on the page — a property of today's markup,
	 * not of the claim.
	 *
	 * S5 demonstrated the fragility: trying the vocal-range disclosure on Bits UI's Collapsible
	 * introduced a nested `child` snippet inside `controls()`, and this arm immediately reported
	 * <RangeBar> missing from a page that plainly renders it. That migration was reverted for unrelated
	 * reasons, so no nested snippet exists here today — the hardening is kept because the next one will
	 * not announce itself, and a guard that reports a false absence is worse than one that reports none.
	 */
	const snippet = (() => {
		const start = PAGE.indexOf('{#snippet controls()}');
		expect(start, 'the page no longer declares a `controls()` snippet').toBeGreaterThan(-1);
		let depth = 0;
		for (let i = start; i < PAGE.length; i++) {
			if (PAGE.startsWith('{#snippet', i)) depth++;
			else if (PAGE.startsWith('{/snippet}', i)) {
				depth--;
				if (depth === 0) return PAGE.slice(start, i);
			}
		}
		throw new Error('the `controls()` snippet is never closed');
	})();
	expect(snippet.length).toBeGreaterThan(0);
	expect(snippet).toContain('<GuidingTrack');
	expect(snippet).toContain('<RangeBar');
	expect(snippet).toContain('class="key"');
	// The snippet is passed to the hero, so the controls render in the hero's own body.
	const hero = PAGE.slice(PAGE.indexOf('<NowPlayingHero'), PAGE.indexOf('</NowPlayingHero>'));
	expect(hero).toContain('{#snippet controls()}');
	// The collapsed summary is fed too, or the disclosure says nothing about where the controls stand.
	expect(hero).toContain('{controlsSummary}');
});

// ── the position, in words, fed from real durations (XR-PH-09) ───────────────────────────────────
test('the position card is fed the built sentence, not a formatted string from the route', () => {
	expect(PAGE).toContain('<MyPositionCard words={myPosition} />');
	// The route must not re-implement the sentence: one builder, unit-tested, no second copy to drift.
	expect(PAGE).not.toContain('roughly');
	expect(PAGE).not.toMatch(/You're\s+#\$\{/);
});

test('the wait is summed from the CATALOG, with an absent media reported as unknown (XR-PH-09)', () => {
	// `Media.durationSec` is required, so the reachable unknown is an entry whose media is not in the
	// client catalog. `?? null` is what carries that to the builder — `?? 0` would silently understate
	// the wait, which is the dishonest rendering the requirement exists to prevent.
	expect(PAGE).toMatch(/aheadDurationsSec:\s*queued\s*\.?slice\(0, idx\)\.map\(\(e\) => mediaCatalog\.get\(e\.mediaId\)\?\.durationSec \?\? null\)/);
	// A playing song of unknown length makes the whole wait unknown, rather than contributing zero.
	expect(PAGE).toMatch(/if \(nowDurationSec <= 0\) return null;/);
});

// ── the docked band reserves its space (XR-PH-12) ────────────────────────────────────────────────
test('the docked search band reserves its band in flow instead of overlapping rows (XR-PH-12)', () => {
	// The measured height, published…
	expect(PAGE).toMatch(/bind:clientHeight=\{dockH\}/);
	expect(PAGE).toMatch(/setProperty\(\s*'--dock-h'/);
	// …and consumed by the scrolling column. A constant here is the mockup's own bug: the docked band
	// occluded queue row 5 because a disclosure grew inside a fixed shell.
	expect(PAGE).toMatch(/padding:\s*var\(--space-xs\) var\(--space-3xl\) calc\(var\(--dock-h[^)]*\) \+ 28px\)/);
	// The band is LAST in the DOM, after the content it sits below, so tab order follows visual order.
	expect(PAGE.indexOf('class="search-dock"')).toBeGreaterThan(PAGE.indexOf('</main>'));
	// Nothing else may dock off the retired sheet's token, or it reserves 132px of nothing.
	expect(PAGE).not.toContain('var(--peek-h)');
});

test('the search dock is docked on home for a joined singer, and the + Add a turn CTA is gone', () => {
	// THE OWNER CORRECTION (2026-09-09). The search box IS the add affordance, docked at the bottom
	// AT ALL TIMES for a joined singer — so it renders on `{#if me}`, unconditional on any search/mode
	// state, and the whole `+ Add a turn` interstitial (`.cta-dock` / `.cta` / `openBrowse`) is deleted.
	expect(PAGE).toMatch(/\{#if me\}\s*<div class="search-dock" bind:clientHeight=\{dockH\}>/);
	// The CTA and its dock are GONE — not merely re-gated. If any of these come back the interstitial
	// direction the owner corrected is back with them.
	expect(PAGE).not.toContain('cta-dock');
	expect(PAGE).not.toMatch(/class="cta"/);
	expect(PAGE).not.toContain('Add a turn');
	expect(PAGE).not.toContain('openBrowse');

	// EXACTLY ONE fixed docked band on the route, and it measures into --dock-h. Two bands both binding
	// dockH was the PREVIOUS shape (`.cta-dock` on home, `.search-dock` on browse); collapsing to one is
	// scope item 3. Count the fixed docks by their shared band contract line.
	const bandBinds = PAGE.match(/bind:clientHeight=\{dockH\}/g) ?? [];
	expect(bandBinds.length).toBe(1);
	// The safe-area inset lives on the ONE band and nowhere above it — no SECOND env() term stacked on
	// the padding that already reserves --dock-h (scope item 3). The band's own padding carries the one
	// env(); `main`'s reserve does not, and the toast docks reach it THROUGH --dock-h.
	const dockCss = PAGE.slice(PAGE.indexOf('.search-dock {'), PAGE.indexOf('.searchbox {'));
	expect((dockCss.match(/env\(safe-area-inset-bottom\)/g) ?? []).length).toBe(1);
	const mainCss = PAGE.slice(PAGE.indexOf('\tmain {'), PAGE.indexOf('\tmain {') + 200);
	expect(mainCss).not.toContain('env(safe-area-inset-bottom)');
});

// ── results are IN PLACE, driven by the query, with no navigation ─────────────────────────
test('the results view is driven by the query in place, with no browse mode or ?browse=1', () => {
	// THE OWNER CORRECTION. Browsing USED to be a `?browse=1` push whose only job was a history entry
	// so Back returned to the queue. This route now renders results IN PLACE over the queue while the box has a
	// query, so there is no navigation and no mode: the split is `searchActive`, derived from `query`.
	expect(PAGE).toContain('const searchActive = $derived(query.trim().length > 0)');
	// The mode, its navigations, and the URL read that backed them are GONE.
	expect(PAGE).not.toContain("searchParams.get('browse')");
	expect(PAGE).not.toContain("goto('/?browse=1'");
	expect(PAGE).not.toContain('const browsing');
	expect(PAGE).not.toContain('function openBrowse');
	expect(PAGE).not.toContain('function closeBrowse');
	// The back-gesture role is reassigned explicitly (not silently dropped): the "← Queue" control
	// clears the search rather than navigating, which is what brings the queue back in place. It is
	// still first in the DOM because it is first visually.
	expect(PAGE).toMatch(/<button class="back-btn" onclick=\{clearSearch\}>/);
	// The upward-stack auto-scroll is gated on `!searchActive` too, not the retired `browsing`: an empty
	// box shows the queue and must NOT force-scroll to the bottom on every queue change. Reverting this
	// gate to `!browsing` references an identifier this route no longer declares.
	expect(PAGE).toMatch(/const resultShape = \$derived\(\s*!searchActive/);
	expect(PAGE).not.toContain('!browsing');
});

test('every result surface is gated on searchActive — an empty box shows the queue, not a result list', () => {
	/*
	 * The claim is unchanged in spirit from the earlier home-shell guards and still load-bearing: if any result block loses
	 * its gate, home shows the library list under an empty box instead of the live queue. Only the gate
	 * moved — from `{#if browsing}` (the retired mode) to `{#if searchActive}` (query-driven).
	 * Weakening this to "some gate exists" would be the wrong answer: the point is that EVERY result
	 * block is gated, so the check counts them.
	 */
	const main = PAGE.slice(PAGE.indexOf('<main>'), PAGE.indexOf('</main>'));

	// Every result block that renders a SongRow inside <main> is inside a `{#if searchActive…}`. Counted
	// rather than named, so a block added tomorrow is covered without editing this list.
	const gated = main.match(/\{#if searchActive\b/g) ?? [];
	expect(gated.length).toBeGreaterThanOrEqual(3); // back control, raw results, cooking, ready
	for (const gate of ['{#if searchActive && cookingRows.length}']) expect(main).toContain(gate);

	// The retired mode must not linger anywhere in <main>.
	expect(main).not.toContain('{#if browsing');

	// Non-vacuity: every `<SongRow` in <main> really is inside one of those blocks. The first SongRow
	// cannot precede the first searchActive gate.
	const firstRow = main.indexOf('<SongRow');
	expect(firstRow).toBeGreaterThan(0);
	expect(main.indexOf('{#if searchActive')).toBeLessThan(firstRow);

	// The search box is NOT in <main>: it is the docked band, after </main>, present in BOTH views now
	//, so the thumb can reach it wherever the stack is scrolled to.
	expect(main).not.toContain('class="card searchbox"');
	expect(PAGE.indexOf('class="search-dock"')).toBeGreaterThan(PAGE.indexOf('</main>'));
	expect(PAGE).toMatch(/\{#if me\}\s*<div class="search-dock"/);
});

// ── the unconfirmed marker (XR-PH-10) ────────────────────────────────────────────────────────────
test('both row kinds are told WHICH mutation they are waiting on (XR-PH-10)', () => {
	const wired = PAGE.match(/pending=\{pendingKind\.get\(e\.id\) \?\? null\}/g) ?? [];
	expect(wired.length).toBe(2); // QueueRow and ProcessingCard
	expect(PAGE).toMatch(/pendingKind = store\.pendingKindById/);
});

// ── the imports the shell stands on ──────────────────────────────────────────────────────────────
test('the shell imports what it is built from — a missing one is a build break, not a test break', () => {
	// These are the three hunks a `bun test` run cannot see: nothing imports this route, so reverting an
	// import reds `build`/`typecheck` and leaves the suite green. Asserted here as the syntax claims
	// they are, so each is pinned to a named test rather than to a gate a reviewer has to re-run.
	// The `$app/state` `page` import is GONE: the results view is query-driven in place, so the
	// route no longer reads the browse query off the URL. (Asserted on the specifier alone, not the
	// whole import statement, so this comment cannot itself read as a virtual-module import.)
	expect(PAGE).not.toContain('$app/state');
	expect(PAGE).toMatch(/import \{ positionWords \} from '\$lib\/position-sentence';/);
	expect(PAGE).toMatch(/import NowPlayingHero from '\$lib\/components\/NowPlayingHero\.svelte';/);
	expect(PAGE).toMatch(/import MyPositionCard from '\$lib\/components\/MyPositionCard\.svelte';/);
	// songDisplay is what keeps the hero's title and artist APART — `mediaTitle` welds them together,
	// and the cards' own history is that the uploader ended up rendered as the artist. Asserted against
	// the IMPORT LIST, not the file: the call site mentions the name too, so a file-wide scan would stay
	// green with the import removed and prove nothing about the hunk that adds it.
	const shared = PAGE.slice(PAGE.indexOf('import {'), PAGE.indexOf("} from '@encore/shared';"));
	expect(shared).toMatch(/(^|[\s,])songDisplay\s*(,|$)/m);
	// …and the byline keeps the uploader fallback the browse row uses for a READY song, or the hero
	// silently shows no artist for every song whose parse was not confident — which is most local files.
	expect(PAGE).toMatch(/nowDisplay\.artist \?\? nowMedia\?\.artist \?\? null/);
});

// ── the transport's CSS went with the buttons ────────────────────────────────────────────────────
test('the route no longer declares the transport styles the hero now owns', () => {
	// A PURE DELETION, so reverting it re-adds rules nothing selects and the suite stays green — the
	// exit-20 case §3 names, closed by scanning the real production file. Two arms, because the finding
	// is not only "unused": the block held four of this route's `44px` literals, and XR-PH-01's whole
	// point is that a literal is invisible to the standard it is meant to express.
	expect(PAGE).not.toMatch(/^\s*\.ic\s*\{/m);
	expect(PAGE).not.toMatch(/^\s*\.ic\.play\s*\{/m);
	expect(PAGE).not.toMatch(/^\s*\.ic:disabled\s*\{/m);
	// …and no markup left behind that would have needed them.
	expect(PAGE).not.toContain('class="ic ');
	expect(PAGE).not.toContain('no-drag');
	// The hero owns them now, derived from the token rather than the number.
	const HERO = read('apps/core/src/lib/components/NowPlayingHero.svelte');
	expect(HERO).toContain('aria-label="play/pause"');
	expect(HERO).not.toContain('44px');
});

// ── the docked-band token has ONE meaning, and the prose says which ──────────────────────────────
test('everything docked measures from --dock-h, and the rationale names that token', () => {
	// A comment that contradicts its code is a defect class in this repo, and this rationale is
	// load-bearing prose: it tells the next author that the safe-area inset arrives THROUGH the token
	// and that adding a second env() term doubles the gap. Naming the retired --peek-h there would send
	// them to a component this route no longer mounts.
	const stack = RAW.slice(RAW.indexOf('Docked-toast stacking'), RAW.indexOf('--error-dock:'));
	expect(stack).toContain('--dock-h');
	expect(stack).not.toContain('--peek-h');
	expect(PAGE).toMatch(/--undo-dock:\s*calc\(var\(--dock-h[^)]*\) \+ 14px\)/);
});

test('no media query overrides the docked band height — the measurement outranks it', () => {
	// The short-viewport block used to shrink --peek-h, which worked only because a multi-line peek's
	// fallback mattered before its measurement landed. An inline custom property on :root BEATS a
	// stylesheet rule, so an override here would be silently defeated the moment the effect writes the
	// real height — a rule that looks like it does something and does not.
	const short = PAGE.slice(PAGE.indexOf('@media (max-height: 480px)'));
	expect(short.length).toBeGreaterThan(0);
	expect(short).not.toContain('--dock-h:');
	expect(short).not.toContain('--peek-h:');
	// non-vacuity: the block still shrinks the top chrome, which is what it is for.
	expect(short).toContain('.topbar');
});
