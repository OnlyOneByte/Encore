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
//
// ══ THE BAND / FIND PHASE, AND WHAT IT REVERSED ═════════════════════════════════════════════════
//
// Three of this file's claims were written about a phone whose BOTTOM EDGE belonged to a docked search
// box on `/`. That is no longer true and the change was deliberate, so the reversals are recorded here
// once and again at each arm rather than being quietly dropped:
//
//   1. THE DOCKED BAND IS `NowPlayingBand`, mounted in `routes/+layout.svelte` inside a `.dock`
//      positioning wrapper, as the bottom-most app chrome on EVERY phone surface. `--dock-h` is
//      therefore the BAND's measured height, published by the LAYOUT. It used to be `.search-dock` in
//      this route, publishing its own height — an address that stopped being true the moment something
//      docked below it.
//   2. SEARCH IS A ROUTE, `routes/find/+page.svelte`, reached by tapping the band's magnifier. The
//      earlier ruling ("no browse MODE, no `?browse=1`, results expand upward IN PLACE, so there is
//      nothing to back out of") was sound about a box on home; once search is somewhere you GO, a route
//      is what makes the phone's own back gesture work. The mode/`?browse=1` prohibition SURVIVES — it
//      is now checked on both surfaces.
//   3. THE ZERO-QUERY STATE SHOWS THE LIBRARY, not the queue. Home is queue-only and renders no result
//      surface at all; the find surface's default content is the songs that can be sung right now.
//
// What did NOT change: XR-PH-12 (the band is reserved in normal flow off its MEASURED height, never a
// constant), the one-env() rule (exactly one `env(safe-area-inset-bottom)` in the docked stack, on the
// element that actually sits at the bottom edge), the query-driven split, and the retirement of the
// `+ Add a turn` interstitial. Each is asserted at its new address at the same or greater strength.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

function stripComments(src: string): string {
	return src
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const RAW = read('src/routes/+page.svelte');
const PAGE = stripComments(RAW);
// The three surfaces the shell was split across. Read here so every arm asserts what is actually
// there: the layout owns the band and the token, the find route owns search, the band owns the inset.
const LAYOUT = stripComments(read('src/routes/+layout.svelte'));
const FIND = stripComments(read('src/routes/find/+page.svelte'));
const BAND = stripComments(read('src/lib/components/NowPlayingBand.svelte'));

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
	// …and behind the JOINED branch, so a guest still gets the landing page rather than a bare queue.
	/*
	 * REVERSED (the band/find phase, §3 of the header note). This clause used to read
	 * `{#if !searchActive}` — the queue was one ARM of a two-view page, and that gate was what kept a
	 * result list from stacking over the rotation. Search has LEFT this route, so home is QUEUE-ONLY and
	 * there is no second arm to gate against; `searchActive` is not even declared here any more.
	 *
	 * Replaced at GREATER strength rather than re-pointed, because the new shape allows a stronger
	 * claim: the rows are still pinned behind a branch (`{#if me}`, whose else-arm is the landing page),
	 * AND the route is asserted to render no result surface AT ALL. A result list that cannot exist here
	 * cannot stack over the queue, which is what the old gate was buying.
	 */
	const joinedStart = main.indexOf('{#if me}');
	expect(joinedStart).toBeGreaterThanOrEqual(0);
	expect(main.indexOf('{#each queued as e, i (e.id)}')).toBeGreaterThan(joinedStart);
	expect(main).toContain('<JoinLanding />');
	// No result surface on this route: no song rows, no query-driven split, no search box.
	expect(PAGE).not.toContain('<SongRow');
	expect(PAGE).not.toContain('searchActive');
	expect(PAGE).not.toContain('findbox');
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
	expect(PAGE).toMatch(
		/aheadDurationsSec:\s*queued\s*\.?slice\(0, idx\)\.map\(\(e\) => mediaCatalog\.get\(e\.mediaId\)\?\.durationSec \?\? null\)/
	);
	// A playing song of unknown length makes the whole wait unknown, rather than contributing zero.
	expect(PAGE).toMatch(/if \(nowDurationSec <= 0\) return null;/);
});

// ── the docked band reserves its space (XR-PH-12) ────────────────────────────────────────────────
test('the docked band reserves its band in flow instead of overlapping rows (XR-PH-12)', () => {
	/*
	 * RE-POINTED, AND THE OWNERSHIP IS WHAT MOVED (header note §1). XR-PH-12 itself is untouched: the
	 * band's height is MEASURED and reserved in normal flow, never guessed at with a constant. What
	 * changed is who measures and who reserves. `.search-dock` in this route used to do both; the bottom
	 * edge is `NowPlayingBand`'s now, so `routes/+layout.svelte` binds the `.dock` wrapper's
	 * clientHeight and publishes `--dock-h`, and there are TWO consumers reserving it instead of one.
	 * Asserted at both ends at the same strength, plus the new negative — this route must NOT publish
	 * the token, because two writers of an inline `:root` property fight silently.
	 */
	// The measured height, published — by the LAYOUT now, off the dock that actually holds the band.
	expect(LAYOUT).toMatch(/bind:clientHeight=\{dockH\}/);
	expect(LAYOUT).toMatch(/setProperty\(\s*'--dock-h'/);
	expect(PAGE).not.toMatch(/bind:clientHeight=\{dockH\}/);
	expect(PAGE).not.toMatch(/setProperty\(\s*'--dock-h'/);
	// …and consumed by EVERY scrolling column. A constant here is the mockup's own bug: the docked band
	// occluded queue row 5 because a disclosure grew inside a fixed shell.
	for (const [where, src] of [
		['routes/+page.svelte', PAGE],
		['routes/find/+page.svelte', FIND]
	] as const) {
		expect(src, `${where} must reserve the measured band in normal flow`).toMatch(
			/padding:\s*var\(--space-xs\) var\(--space-3xl\) calc\(var\(--dock-h[^)]*\) \+ 28px\)/
		);
	}
	// The band is LAST in the DOM, after the content it sits below, so tab order follows visual order.
	expect(LAYOUT.indexOf('class="dock"')).toBeGreaterThan(LAYOUT.indexOf('{@render children()}'));
	// Nothing may dock off the retired sheet's token, or it reserves 132px of nothing.
	for (const src of [PAGE, FIND, LAYOUT, BAND]) expect(src).not.toContain('var(--peek-h)');
});

test('the now-playing band is docked for a joined singer, and the + Add a turn CTA is still gone', () => {
	/*
	 * REVERSED (header note §1). THE 2026-09-09 OWNER CORRECTION docked the SEARCH BOX at the bottom of
	 * home "at all times for a joined singer", because the box WAS the add affordance. The band phase
	 * takes that edge back: `NowPlayingBand` is the bottom-most app chrome on every phone surface, docked
	 * from `routes/+layout.svelte`, and the add affordance is the band's magnifier — a tap that navigates
	 * to /find. So the docked-for-a-joined-singer requirement is not dropped; it MOVES and WIDENS, from
	 * one route to every phone surface, and is asserted at the layout that mounts it.
	 *
	 * The `+ Add a turn` interstitial the owner corrected away stays retired, unchanged, and is now
	 * checked on all three surfaces rather than one — the find route is where a `browseToggle` would most
	 * plausibly come back, since it IS the browse view.
	 */
	// Docked, gated on a joined singer, and it is the BAND that is mounted there.
	expect(LAYOUT).toMatch(/\{#if showBand\}\s*<div class="dock" bind:clientHeight=\{dockH\}>/);
	expect(LAYOUT).toContain('<NowPlayingBand');
	// `showBand` is what carries "joined singer" — a guest on the landing page gets no band, and the
	// television (which is not a phone surface) gets none either.
	expect(LAYOUT).toMatch(/const showBand = \$derived\(isPhoneSurface && me !== null\)/);
	// The magnifier is the add affordance now: it navigates to the find surface.
	expect(LAYOUT).toMatch(/onsearch=\{\(\) => goto\('\/find'\)\}/);

	// The CTA and its dock are GONE — not merely re-gated — on every surface that could host them. If
	// any of these come back the interstitial direction the owner corrected is back with them.
	for (const [where, src] of [
		['routes/+page.svelte', PAGE],
		['routes/find/+page.svelte', FIND],
		['routes/+layout.svelte', LAYOUT]
	] as const) {
		expect(src, `${where}: the retired interstitial dock`).not.toContain('cta-dock');
		expect(src, `${where}: the retired interstitial button`).not.toMatch(/class="cta"/);
		expect(src, `${where}: the retired interstitial copy`).not.toContain('Add a turn');
		expect(src, `${where}: the retired browse push`).not.toContain('openBrowse');
		expect(src, `${where}: the retired browse toggle`).not.toContain('browseToggle');
	}

	// EXACTLY ONE fixed docked band across the phone surfaces, and it measures into --dock-h. Two bands
	// both binding dockH was the shape BEFORE the owner correction (`.cta-dock` on home, `.search-dock`
	// on browse); collapsing to one survived the band phase and is counted across all three files.
	const bandBinds = [LAYOUT, PAGE, FIND].join('\n').match(/bind:clientHeight=\{dockH\}/g) ?? [];
	expect(bandBinds.length).toBe(1);
	/*
	 * THE ONE-env() RULE, unchanged in substance and re-pointed to the three files it now spans. The
	 * inset lives on the element that actually sits at the bottom edge of the screen — the BAND's own
	 * padding — and reaches everything stacked above it THROUGH --dock-h, which is bound to the wrapper's
	 * clientHeight and so includes that padding. A second env() term anywhere above doubles the gap on a
	 * notched phone. So: one on the band, none on the `.dock` wrapper (positioning only), none on either
	 * column's reserve.
	 */
	const bandCss = BAND.slice(BAND.indexOf('.band {'), BAND.indexOf('.inner {'));
	expect((bandCss.match(/env\(safe-area-inset-bottom/g) ?? []).length).toBe(1);
	// Non-vacuity on the two slices below: an unmatchable selector slices to nothing, and a
	// `not.toContain` over nothing passes while examining nothing.
	const dockCss = LAYOUT.slice(LAYOUT.indexOf('.dock {'));
	expect(LAYOUT.indexOf('.dock {'), '.dock must still be the positioning wrapper rule').toBeGreaterThan(-1);
	expect(dockCss).not.toContain('env(safe-area-inset-bottom');
	for (const [where, src] of [
		['routes/+page.svelte', PAGE],
		['routes/find/+page.svelte', FIND]
	] as const) {
		const mainCss = src.slice(src.indexOf('\tmain {'), src.indexOf('\tmain {') + 200);
		expect(mainCss, `${where} must still declare a top-level main rule`).toContain('padding:');
		expect(mainCss, `${where}'s reserve must not add a second env() term`).not.toContain(
			'env(safe-area-inset-bottom'
		);
	}
});

// ── results are driven by the QUERY, on the surface that owns the box ─────────────────────────
test('the results view is driven by the query on the find route, with no browse mode or ?browse=1', () => {
	/*
	 * PARTLY REVERSED (header note §2), AND THE REVERSAL IS THE NAVIGATION. The recorded ruling was "no
	 * browse MODE, no `?browse=1`, results expand upward IN PLACE, so there is nothing to back out of".
	 * That reasoning was sound and it was about a box docked on HOME. The band took the bottom edge, so
	 * search became a place you GO — a tap on the band's magnifier — and once it is somewhere you go, a
	 * ROUTE is what the ruling's own argument asks for: the phone's back gesture works, the surface is
	 * shareable, and the queue does not re-render under a keyboard.
	 *
	 * WHAT DID NOT REVERSE, asserted unchanged at its new address: the split between the default view and
	 * the results view is driven purely by the QUERY, through `searchActive` derived from it. A mode flag,
	 * a `?browse=1` push, or a URL read would still be exactly the defect the ruling named — so the
	 * prohibition is KEPT and widened to both surfaces.
	 */
	expect(FIND).toContain('const searchActive = $derived(query.trim().length > 0)');
	// The mode, its navigations, and the URL read that backed them are GONE from both phone routes.
	for (const [where, src] of [
		['routes/+page.svelte', PAGE],
		['routes/find/+page.svelte', FIND]
	] as const) {
		expect(src, `${where} must not read a browse mode off the URL`).not.toContain("searchParams.get('browse')");
		expect(src, `${where} must not push the retired browse route`).not.toContain("goto('/?browse=1'");
		expect(src, `${where} must not declare a browse mode`).not.toContain('const browsing');
		expect(src, `${where} must not declare a browse mode`).not.toContain('function openBrowse');
		expect(src, `${where} must not declare a browse mode`).not.toContain('function closeBrowse');
		expect(src, `${where} must not gate on the retired mode`).not.toContain('!browsing');
	}
	/*
	 * THE BACK ROLE, reassigned a second time and STATED rather than silently dropped. Under the docked
	 * box it was an on-screen "← Queue" control calling `clearSearch()`, because there was no history
	 * entry to pop and nothing to navigate back to. On a route it is a REAL link to `/` (PageHeader's
	 * `back`), which is what makes the phone's own back gesture and a home-screen PWA's in-app exit both
	 * land on the queue — and it is a stronger affordance than the button it replaces, not a weaker one.
	 */
	expect(FIND).toMatch(/back=\{\{ href: '\/', label: '[^']+' \}\}/);
	expect(FIND).not.toContain('data-testid="back-to-queue"');
	// `clearSearch` survives with the NARROWER job the route left it: emptying the box, which restores the
	// zero-query view. It is wired to the box's own clear control, not standing in for a back gesture.
	expect(FIND).toMatch(/function clearSearch\(\)/);
	expect(FIND).toMatch(/aria-label="Clear the search" onclick=\{clearSearch\}/);
	/*
	 * The upward-stack auto-scroll and its `resultShape` gate are GONE rather than re-gated, and the
	 * premise is what removed them: results grew UPWARD towards a box pinned at the bottom, so a new
	 * result had to be scrolled into view. The box sits at the TOP now and results flow down the
	 * page, which is the ordinary reading direction and needs no scrolling of its own. So there is no
	 * gate left to get wrong — which is why this is a prohibition and not a re-pointed assertion.
	 */
	expect(FIND).not.toContain('resultShape');
	expect(FIND).not.toMatch(/scrollTo\(|scrollIntoView\(/);
});

test('every result surface is gated on the query — an empty box shows the LIBRARY, never a stale list', () => {
	/*
	 * REVERSED IN WHAT THE ZERO-QUERY STATE SHOWS (header note §3), KEPT in the invariant that made it
	 * matter.
	 *
	 * THE OLD CLAIM: an empty box shows the QUEUE, so every result block had to be gated or home rendered
	 * a library list under an empty box. Search is its own surface now, so home has no result blocks at
	 * all (pinned by the rotation-rows arm above) and the empty box shows THE LIBRARY — the songs that can
	 * actually be sung right now, as the find surface's default content. That is the deliberate reversal:
	 * the library used to be hidden behind two rails of shortcuts; it IS the zero-query view.
	 *
	 * WHAT SURVIVES is the bleed rule, at equal strength and counted rather than named: the library group
	 * renders ONLY with an empty box, the query-scoped groups render ONLY with a query, and neither view
	 * may show the other's list. Weakening this to "some gate exists" would be the wrong answer, so both
	 * sides of the split are checked.
	 */
	const main = FIND.slice(FIND.indexOf('<main>'), FIND.indexOf('</main>'));

	// The query-scoped result groups (ready, raw, the no-results state) are gated on a query…
	const gated = main.match(/\{#if searchActive\b/g) ?? [];
	expect(gated.length).toBeGreaterThanOrEqual(1);
	// …and the zero-query view — the LIBRARY, not the queue — is gated on its absence.
	expect(main).toContain('{#if !searchActive}');
	expect(main).toContain('{#each libraryRows as m (m.id)}');
	// Home's list is not duplicated here: the find surface renders no rotation rows, so the two surfaces
	// cannot disagree about the queue.
	expect(main).not.toContain('<QueueRow');
	expect(main).not.toContain('{#each queued as e');

	// The retired mode must not linger anywhere in <main>.
	expect(main).not.toContain('{#if browsing');

	/*
	 * THE PROCESSING GROUP IS DELIBERATELY UNGATED, and this is the one clause the reversal REWRITES
	 * rather than moves. It used to be pinned as `{#if searchActive && processingRows.length}`; it now
	 * renders in BOTH views, because what is being made right now is the thing most likely to be asked
	 * about and is equally relevant with an empty box.
	 *
	 * That is not a lost gate, and the replacement is stronger: the group's MEMBERSHIP is query-scoped at
	 * the data layer instead, and `searchActive` is fed to the pure helper that computes it. A template
	 * gate can only hide the whole group; the helper decides row by row, and it is unit-testable.
	 */
	expect(main).toContain('{#if processingRows.length}');
	expect(FIND).toMatch(/processingGroupIds\(\{\s*searchActive,/);

	// Non-vacuity: every `<SongRow` in <main> really is inside one of those blocks. The first SongRow
	// cannot precede the first gate.
	const firstRow = main.indexOf('<SongRow');
	expect(firstRow).toBeGreaterThan(0);
	expect(main.indexOf('{#if !searchActive}')).toBeLessThan(firstRow);

	/*
	 * THE BOX IS IN <main> AND AT THE TOP — the exact inverse of the clause this replaces, which asserted
	 * the box was NOT in <main> because it was the docked band, "so the thumb can reach it wherever the
	 * stack is scrolled to". The band owns that edge now, and two surfaces fighting for one edge is the
	 * stack this route exists to unwind. So the box sits at the top of the column in NORMAL FLOW, and
	 * nothing on this route is fixed or stuck to anything.
	 */
	expect(main).toContain('class="findbox"');
	const boxCss = FIND.slice(FIND.indexOf('.findbox {'), FIND.indexOf('.findbox input {'));
	// NEITHER STICKY NOR FIXED, which is the stronger claim and the one actually decided. Sticky was
	// tried and abandoned: PageHeader is already sticky and carries the top safe-area inset, so a second
	// sticky element needs the header's RENDERED height as its offset — not a token, and the first
	// attempt reached past the end of the spacing scale, which makes the calc() invalid and slides the
	// box under the title with nothing failing out loud. Pinning the ABSENCE of both is what stops the
	// box quietly re-entering the competition for the viewport that the band now wins outright.
	expect(boxCss).not.toMatch(/position:\s*(?:sticky|fixed)/);
	// The retired address is gone rather than merely unscanned.
	expect(FIND).not.toContain('search-dock');
	expect(PAGE).not.toContain('search-dock');
});

// ── the unconfirmed marker (XR-PH-10) ────────────────────────────────────────────────────────────
test('both row kinds are told WHICH mutation they are waiting on (XR-PH-10)', () => {
	const wired = PAGE.match(/pending=\{pendingKind\.get\(e\.id\) \?\? null\}/g) ?? [];
	expect(wired.length).toBe(2); // QueueRow and ProcessingCard
	// Both hops since the room-link hoist: the link re-reads the kind map off the QueueStore it now
	// owns, and the page mirrors the link's copy. Either hop breaking is the same stale-marker defect.
	expect(read('src/lib/stores/room.ts')).toMatch(/this\.pendingKind = this\.queue!\.pendingKindById/);
	expect(PAGE).toMatch(/pendingKind = room\.pendingKind/);
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
	expect(PAGE).toMatch(/import \{ positionWords \} from '\$lib\/phrasing\/position-sentence';/);
	expect(PAGE).toMatch(/import NowPlayingHero from '\$lib\/components\/NowPlayingHero\.svelte';/);
	expect(PAGE).toMatch(/import MyPositionCard from '\$lib\/components\/MyPositionCard\.svelte';/);
	// songDisplay is what keeps the hero's title and artist APART — `mediaTitle` welds them together,
	// and the cards' own history is that the uploader ended up rendered as the artist. Asserted against
	// the IMPORT LIST, not the file: the call site mentions the name too, so a file-wide scan would stay
	// green with the import removed and prove nothing about the hunk that adds it.
	const shared = PAGE.slice(PAGE.indexOf('import {'), PAGE.indexOf("} from '$lib/contract';"));
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
	const HERO = read('src/lib/components/NowPlayingHero.svelte');
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
