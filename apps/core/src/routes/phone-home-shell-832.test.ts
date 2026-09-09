// Wiring guards for the direction-A phone home shell (issue #832).
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
import { readFileSync } from 'node:fs';

function stripComments(src: string): string {
	return src
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const RAW = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const PAGE = stripComments(RAW);

// ── the queue IS home ────────────────────────────────────────────────────────────────────────────
test('home renders the now-playing HERO, and the queue sheet is gone from this route (#832)', () => {
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
	// …and behind the home branch, so the browse push does not stack the queue under the results.
	const homeStart = main.indexOf('{#if !browsing}');
	expect(homeStart).toBeGreaterThanOrEqual(0);
	expect(main.indexOf('{#each queued as e, i (e.id)}')).toBeGreaterThan(homeStart);
});

test('the live singing controls came WITH the hero, into its disclosure body (XR-PH-15)', () => {
	// The sheet was their only home. Deleting it without relocating them would silently drop guide
	// vocals, key and range from the phone — a user-facing regression no other test would see.
	const snippet = PAGE.slice(PAGE.indexOf('{#snippet controls()}'), PAGE.indexOf('{/snippet}'));
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
test('the docked primary button reserves its band in flow instead of overlapping rows (XR-PH-12)', () => {
	// The measured height, published…
	expect(PAGE).toMatch(/bind:clientHeight=\{dockH\}/);
	expect(PAGE).toMatch(/setProperty\(\s*'--dock-h'/);
	// …and consumed by the scrolling column. A constant here is the mockup's own bug: the docked CTA
	// occluded queue row 5 because a disclosure grew inside a fixed shell.
	expect(PAGE).toMatch(/padding:\s*6px 18px calc\(var\(--dock-h[^)]*\) \+ 28px\)/);
	// The band is LAST in the DOM, after the content it sits below, so tab order follows visual order.
	expect(PAGE.indexOf('class="cta-dock"')).toBeGreaterThan(PAGE.indexOf('</main>'));
	// Nothing else may dock off the retired sheet's token, or it reserves 132px of nothing.
	expect(PAGE).not.toContain('var(--peek-h)');
});

test('one primary action, and it is not on the browse screen', () => {
	const docks = PAGE.match(/class="cta-dock"/g) ?? [];
	expect(docks.length).toBe(1);
	expect(PAGE).toMatch(/\{#if me && !browsing\}\s*<div class="cta-dock"/);
	expect(PAGE).toMatch(/<button class="cta" onclick=\{openBrowse\}>/);
});

// ── browsing is a push, and it is reversible ─────────────────────────────────────────────────────
test('the browse push is a real navigation, so the phone Back gesture dismisses it', () => {
	// A local boolean would leave Back exiting the app from the browse screen — and would lose the
	// search state on a reload. Same route either way, so the query and the library survive the trip.
	expect(PAGE).toMatch(/const browsing = \$derived\(page\.url\.searchParams\.get\('browse'\) === '1'\)/);
	/*
	 * The OPTION OBJECT is pinned, not just the URL (#833). `goto('/?browse=1')` pushes a history entry,
	 * which is what makes Back close browse rather than leave the room; `goto('/?browse=1', {
	 * replaceState: true })` REPLACES it, silently turning the ruled-on option A back into option B —
	 * and a match that stopped at the closing quote of the path stayed green through exactly that edit.
	 */
	expect(PAGE).toMatch(
		/function openBrowse\(\) \{\s*void goto\('\/\?browse=1', \{ keepFocus: true, noScroll: false \}\);\s*\}/
	);
	expect(PAGE).toMatch(/function closeBrowse\(\) \{\s*void goto\('\/', \{ keepFocus: true, noScroll: false \}\);\s*\}/);
	expect(PAGE).not.toContain('replaceState');
	// …and a visible way back, first in the DOM because it is first visually.
	expect(PAGE).toMatch(/<button class="back-btn" onclick=\{closeBrowse\}>/);
});

test('every browse surface is behind the push — home cannot show the library list', () => {
	/*
	 * RE-ANCHORED BY #833, ON THE RECORD (XR-VER-07). The CLAIM is unchanged and still load-bearing: if
	 * any browse block loses its gate, home silently becomes the browse-first screen direction A
	 * replaced. Only the anchors moved, because #833 deleted the mechanisms this test used to name —
	 * `{#if browsing && showReady}`, `{#if browsing && showCooking && …}`, `{#if browsing && showRaw}`
	 * and `{#if browsing && filter !== 'all'}` were all gates on the readiness FILTER, and there is no
	 * filter any more. Weakening this to "some gate exists" was the wrong answer: the point is that
	 * EVERY browse block is gated, so the check counts them.
	 */
	const main = PAGE.slice(PAGE.indexOf('<main>'), PAGE.indexOf('</main>'));

	// Every result block that renders a SongRow inside <main> is inside a `{#if browsing…}`. Counted
	// rather than named, so a block added tomorrow is covered without editing this list.
	const gated = main.match(/\{#if browsing\b/g) ?? [];
	expect(gated.length).toBeGreaterThanOrEqual(4); // back control, raw/shortcuts, cooking, ready
	for (const gate of ['{#if browsing && cookingRows.length}']) expect(main).toContain(gate);

	// Non-vacuity: every `<SongRow` in <main> really is inside one of those blocks. `{#if browsing}` is
	// the only conditional the browse blocks open at that indent, so the first SongRow cannot precede
	// the first browse gate — and no SongRow may follow the last `{/if}`.
	const firstRow = main.indexOf('<SongRow');
	expect(firstRow).toBeGreaterThan(0);
	expect(main.indexOf('{#if browsing')).toBeLessThan(firstRow);

	// The search box is NOT in <main> any more: it is the docked band, after </main>, so the thumb can
	// reach it wherever the stack is scrolled to (#833). Home must not dock it — that is the browse
	// screen's band, gated on `browsing`.
	expect(main).not.toContain('class="card searchbox"');
	expect(PAGE.indexOf('class="search-dock"')).toBeGreaterThan(PAGE.indexOf('</main>'));
	expect(PAGE).toMatch(/\{#if browsing\}\s*<div class="search-dock"/);
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
	expect(PAGE).toMatch(/import \{ page \} from '\$app\/state';/); // the browse push reads the URL
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
test('the route no longer declares the transport styles the hero now owns (#832)', () => {
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
	const HERO = readFileSync(new URL('../lib/components/NowPlayingHero.svelte', import.meta.url), 'utf8');
	expect(HERO).toContain('aria-label="play/pause"');
	expect(HERO).not.toContain('44px');
});

// ── the docked-band token has ONE meaning, and the prose says which ──────────────────────────────
test('everything docked measures from --dock-h, and the rationale names that token (#832)', () => {
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
