// Wiring guards for the phone home shell: which component renders where, what is gated on what, which value
// is fed to which prop. A SOURCE SCAN because `routes/+page.svelte` imports `$app/navigation` and
// `$app/state`, so it cannot be mounted at all; every MEASUREMENT claim is asserted against the real DOM in
// phone-home.test.ts instead. These are the assertions that RED when a relocation hunk is reverted, since a
// markup move is invisible to a behavioural suite — nothing imports the route.
//
// The shape they describe: `NowPlayingBand` is composed inside `NowPlayingDrawer` as snap point 0 of a
// permanently-mounted sheet, the LAYOUT is the single writer of `--dock-h`, search is a field at the top of
// `/` with the library under the queue, and `searchActive` is the only switch. There is no now-playing card
// on home, no `.dock` wrapper, no `drawerOpen` and no `onexpand`. See
// docs/GUARDS.md#the-hygiene-and-meta-guards.
import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { at, read } from '@encore/test-support';

function stripComments(src: string): string {
	return src
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const RAW = read('src/routes/+page.svelte');
const PAGE = stripComments(RAW);
// The surfaces the shell is split across, read once: the layout owns the band and the token, the band owns
// the safe-area inset, and `PAGE` owns search.
const LAYOUT = stripComments(read('src/routes/+layout.svelte'));
const BAND = stripComments(read('src/lib/components/NowPlayingBand.svelte'));
// The now-playing surface plus the two vendored drawer files: the drag restriction is only load-bearing if a
// real vaul Handle exists for it to restrict dragging to.
const DRAWER = stripComments(read('src/lib/components/NowPlayingDrawer.svelte'));
const DRAWER_CONTENT = stripComments(read('src/lib/components/ui/drawer/drawer-content.svelte'));
const DRAWER_HANDLE = stripComments(read('src/lib/components/ui/drawer/drawer-handle.svelte'));

test('home renders NO now-playing surface — the layout owns the drawer, and the queue sheet stays gone', () => {
	// Three claims, each falsifiable alone, together saying there is EXACTLY ONE now-playing surface and it is
	// reachable: (a) the hero COMPONENT is gone from the tree, so no surviving import can re-mount it; (b) home
	// mounts none of any kind, so it cannot grow a second and disagree with the layout's; (c) the drawer is
	// mounted once with the band composed INSIDE it — a drawer with no band is the defect a count alone misses.
	// (a) gone from the tree, not merely unmounted.
	expect(existsSync(at('src/lib/components/NowPlayingHero.svelte'))).toBe(false);
	// (b) no now-playing surface on this route, in either direction — element or import.
	for (const surface of ['NowPlayingHero', 'NowPlayingBand', 'NowPlayingDrawer'])
		expect(PAGE, `home must not mount \`${surface}\`: the layout is the one owner`).not.toContain(surface);
	// (c) one drawer, in the layout, permanently mounted.
	expect(LAYOUT).toMatch(/import NowPlayingDrawer from '\$lib\/components\/NowPlayingDrawer\.svelte';/);
	expect((LAYOUT.match(/<NowPlayingDrawer\b/g) ?? []).length).toBe(1);
	// BANS rather than re-pointed assertions: a sheet that never closes has no open state, and a band that IS
	// snap 0 needs nothing to raise it, so re-pointing them would pin a handshake the design deleted.
	expect(LAYOUT, 'a permanently-mounted sheet has no open state').not.toMatch(/\bdrawerOpen\b/);
	expect(LAYOUT, 'the band raises nothing now — it IS the sheet at snap 0').not.toContain('onexpand');
	expect(LAYOUT, 'the layout mounts the drawer; the drawer mounts the band').not.toContain('<NowPlayingBand');
	// …and the band really is in there, once, as the content's FIRST child, measuring itself into snap 0.
	// Ordered against the header so "first child" is a claim rather than a hope.
	expect((DRAWER.match(/<NowPlayingBand\b/g) ?? []).length).toBe(1);
	expect(DRAWER).toMatch(/<div class="band-slot"[^>]*bind:clientHeight=\{bandH\}>/);
	expect(DRAWER.indexOf('class="band-slot"')).toBeGreaterThan(-1);
	expect(DRAWER.indexOf('class="band-slot"')).toBeLessThan(DRAWER.indexOf('<Drawer.Header'));
	// The drag affordance in that slot is vaul's own Handle. A click cannot track a thumb, which is what the
	// band's old click-only button could never be.
	expect(DRAWER).toMatch(/<div class="band-slot"[\s\S]{0,200}?<Drawer\.Handle \/>/);

	// The retired queue sheet must not come back on any of the three surfaces that replaced it, as either the
	// import or the element.
	for (const [where, src] of [
		['routes/+page.svelte', PAGE],
		['routes/+layout.svelte', LAYOUT],
		['NowPlayingDrawer.svelte', DRAWER]
	] as const) {
		expect(src, `${where}: the retired queue sheet`).not.toContain('QueueSheet');
	}
});

test('the rotation rows render inside <main>, not inside a pull-up sheet', () => {
	// Sliced from the OPENING TAG, not the literal `<main>`: the element carries a style attribute (`--row-h`),
	// so the bare-tag literal stopped matching and this compared an empty string against every expectation.
	const main = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>'));
	expect(main).toContain('{#each queued as e, i (e.id)}');
	expect(main).toContain('<QueueRow');
	expect(main).toContain('<ProcessingCard');
	/*
	 * The `{#if !searchActive}` gate is what keeps a result list from stacking over the rotation, and it is
	 * asserted on BOTH sides: the rows behind that gate, and the rows still behind the joined branch (`{#if
	 * me}`, whose else-arm is the landing page) so a guest gets the landing page rather than a bare queue.
	 */
	const joinedStart = main.indexOf('{#if me}');
	expect(joinedStart).toBeGreaterThanOrEqual(0);
	expect(main.indexOf('{#each queued as e, i (e.id)}')).toBeGreaterThan(joinedStart);
	expect(main).toContain('<JoinLanding />');
	// The queue's rows are gated on there being no query, and they are the FIRST thing under that gate.
	const zeroQuery = main.indexOf('{#if !searchActive}');
	expect(zeroQuery).toBeGreaterThan(joinedStart);
	expect(main.indexOf('{#each queued as e, i (e.id)}')).toBeGreaterThan(zeroQuery);
	// The result surface is here rather than banned: the field, the song rows and the query switch.
	expect(PAGE).toContain('<SongRow');
	expect(PAGE).toContain('searchActive');
	expect(PAGE).toContain('findbox');
});

test('the live singing controls live in the DRAWER, which IS the revealing, and home carries none', () => {
	/*
	 * The drawer IS the act of revealing, so a disclosure inside it is a second tap to see what the first was
	 * for. Five claims: (1) all four controls sit inside `.tools-body`; (2) that body is gated on a song playing
	 * NOW, so an idle room is not offered knobs with nothing behind them; (3) the guiding-track slider does not
	 * share a drag surface with the dismiss gesture, with a real vaul Handle pinned alongside the restriction;
	 * (4) the range sits DIRECTLY below the key row it answers about; (5) home carries none of it.
	 */
	// (1) THE SLICE COUNTS NESTING: a slice that stops at the first `</div>` is correct only while `.tools-body`
	// has no nested block, and a guard that reports a false absence is worse than one that reports none.
	const toolsBody = (() => {
		const start = DRAWER.indexOf('<div class="tools-body">');
		expect(start, 'the drawer no longer declares a `.tools-body` live-controls block').toBeGreaterThan(-1);
		let depth = 0;
		for (let i = start; i < DRAWER.length; i++) {
			if (DRAWER.startsWith('<div', i)) depth++;
			else if (DRAWER.startsWith('</div>', i)) {
				depth--;
				if (depth === 0) return DRAWER.slice(start, i);
			}
		}
		throw new Error('the `.tools-body` block is never closed');
	})();
	expect(toolsBody.length).toBeGreaterThan(0);
	// Deleting the hero without relocating these would silently drop guide vocals, key and range from the
	// phone — a user-facing regression no other test would see, which is why each is named rather than counted.
	expect(toolsBody).toContain('<GuidingTrack');
	expect(toolsBody).toContain('<RangeBar');
	expect(toolsBody).toContain('class="key"');
	expect(toolsBody, 'the sheet must not carry the re-selection control').not.toContain('<LyricsReselect');
	expect(toolsBody, 'the lyrics source must still be named').toContain('class="lyricsrc"');
	expect(DRAWER, 'the pill must read the shared contract label, not a local copy of the strings').toContain(
		'lyricsSourceLabel('
	);
	// …and the control really does still exist on the song page, or this is a deletion with no successor.
	expect(read('src/routes/song/[mediaId]/+page.svelte')).toContain('<LyricsReselect');
	// The guide's reason-before-the-dead-row note came with them.
	expect(toolsBody).toContain('class="tools-note"');

	// (2) gated on a song playing NOW — the transport survives an idle room, the knobs do not.
	const hasSongGate = DRAWER.indexOf('{#if hasSong}');
	expect(hasSongGate).toBeGreaterThan(-1);
	expect(hasSongGate).toBeLessThan(DRAWER.indexOf('<div class="tools-body">'));
	// The transport is in the BAND's strip beside the disc, as one cluster (asserted in the transport-styles test
	// below). Three of the four arrangements tried were reported on sight, so what stays pinned HERE is that the
	// sheet must not grow a transport of its own again, in any of the shapes it already has.
	for (const gone of ['class="transport"', 'data-transport="play"', 'aria-label="play/pause"'])
		expect(DRAWER, `the sheet must not carry \`${gone}\` again — the band row is the transport`).not.toContain(gone);
	expect(DRAWER, 'and the band it composes is where the transport lives').toContain('<NowPlayingBand');
	// The pair is wired THROUGH to it, or the controls render inert in the row they moved to.
	for (const wire of ['onrestart={onrestart}', 'onskip={onskip}', 'ontoggleplay={ontoggleplay}'])
		expect(DRAWER, `the band lost its \`${wire}\` wiring`).toContain(wire);
	// THE REVEAL IS RETIRED and its absence is what is pinned: restart and skip were hidden in the collapsed bar
	// only because the magnifier shared the band row, and the magnifier is gone. So the transport must be
	// UNCONDITIONAL and must not go back behind a height state in any of the shapes already tried.
	expect(DRAWER, 'the reveal is retired — no height class may be toggled onto the band again').not.toMatch(
		/classList\.(toggle|add)\('sheet-(up|down)'/
	);
	expect(DRAWER, 'and no wrapper may be reintroduced to hold one').not.toContain('class="band-face"');
	// The band is read again here (it has its own constant below) because the hiding half of the retired reveal
	// lived in THAT file. STRIPPED, because this file's own prose records what the reveal did, and an absence
	// arm reading raw source reds on its own explanation — the trap browse-screen.test.ts documents.
	const BAND_CODE = stripComments(read('src/lib/components/NowPlayingBand.svelte'));
	expect(BAND_CODE, 'the pair must not be hidden at rest again').not.toMatch(/display:\s*none/);
	expect(BAND_CODE, 'and the class the hiding rule keyed on stays gone, so nothing can re-hide by name').not.toContain(
		'tp-side'
	);
	// THE MEASURED CONSTRAINT THAT OUTLIVES THE REVEAL: the band cannot take a prop that CHANGES after mount,
	// and a reactive class directive on the band face is the same defect — `.band-slot` carries
	// `bind:clientHeight`, so any reactive update re-runs its size binding into the mount rung's throw.
	expect(DRAWER, 'the sheet-up class must not come back as a reactive directive').not.toMatch(/class:sheet-up=/);
	expect(DRAWER, 'and must not come back as $state written from an effect either').not.toMatch(/let sheetUp = \$state/);
	expect(DRAWER, 'the band must not be given an expanded/sheetUp prop').not.toMatch(
		/<NowPlayingBand[\s\S]*?(?:expanded|sheetUp)=/
	);

	/*
	 * (3) The whole BAND ROW takes hold of the sheet and the exclusion is inverted: `data-vaul-no-drag` on
	 * `.np-fit`, which vaul resolves with `closest()`, covers head, body, slider, keycaps and visualiser in one
	 * attribute — so a control added to the sheet lands inside it and is excluded by construction. Both halves
	 * are asserted: `handleOnly` GONE, and the attribute on the wrapper rather than anywhere.
	 */
	expect(DRAWER, 'handleOnly is retired — the band row is the drag surface').not.toMatch(
		/<Drawer\.Root\b[^>]*\bhandleOnly\b/
	);
	expect(DRAWER, 'the sheet body must be excluded from dragging').toMatch(/<div class="np-fit" data-vaul-no-drag\b/);
	// …and the band's own controls with it: vaul captures the pointer, so a drag begun on the disc would
	// fire its click on release and pause the song on the way to opening the sheet.
	const BAND_DRAG = read('src/lib/components/NowPlayingBand.svelte');
	// ONE attribute covers all three controls, since vaul resolves it with `closest()`.
	expect(BAND_DRAG, 'the transport group must not be a drag surface').toMatch(/<div class="tp" data-vaul-no-drag>/);
	expect(BAND_DRAG, 'and there must be no control in the row outside that protection').not.toContain(
		'aria-label="Search for a song"'
	);
	// …and a tap that was really a drag must not also toggle the sheet: the metadata block is both the
	// press-to-toggle control and the biggest part of the drag surface.
	expect(BAND_DRAG, 'a drag must not count as a tap on the metadata block').toContain('if (dragged) return;');
	// …and a REAL handle for it to be restricted to: without one the restriction is a silent no-op that makes
	// the drawer undraggable. Exactly ONE element carrying vaul's `data-vaul-handle` must exist, and the
	// vendored content file must not render a competing one — two stacked grab bars shipped once.
	expect(DRAWER).toMatch(/<Drawer\.Handle\b/);
	expect(DRAWER_CONTENT).not.toMatch(/<DrawerHandle\b/);
	expect(DRAWER_HANDLE).toMatch(/<DrawerPrimitive\.Handle\b/);
	// No second disclosure anywhere on this surface: the drawer is the one level of revealing.
	expect(DRAWER).not.toContain('Collapsible');

	// (4) the range is directly below the key row, in DOM order, inside the same body.
	expect(toolsBody.indexOf('class="key"')).toBeLessThan(toolsBody.indexOf('<div class="range">'));

	// (5) home carries none of it: two surfaces reading the same room and writing the same commands disagree
	// under a slow socket.
	for (const gone of [
		'GuidingTrack',
		'RangeBar',
		'LyricsReselect',
		'{#snippet controls()}',
		'controlsSummary',
		'class="key"',
		'class="transport"',
		'aria-label="restart"',
		'aria-label="play/pause"',
		'aria-label="skip"',
		'keyShiftEnabled',
		'canStart'
	])
		expect(PAGE, `home must not carry the live control \`${gone}\` — the drawer owns it`).not.toContain(gone);
});

test('the wait is rendered by a BUILDER, not by a string the route formats itself', () => {
	// The route must not re-implement the phrasing: one formatter, unit-tested, with no second copy to drift. The
	// wait is a clause on the queue row's byline, built by `waitShort`.
	expect(PAGE).not.toContain('<MyPositionCard');
	expect(PAGE).toMatch(/import \{ waitShort \} from '\$lib\/phrasing\/position-sentence';/);
	expect(PAGE).toMatch(/subtitle=\{queueSubtitle\(e\)\}/);
	expect(PAGE).not.toContain('roughly');
	expect(PAGE).not.toMatch(/~\$\{/);
	expect(PAGE).not.toMatch(/You're\s+#\$\{/);
});

test('the wait is summed from the CATALOG, with an absent media reported as unknown', () => {
	// `Media.durationSec` is required, so the reachable unknown is an entry whose media is not in the client
	// catalog. `?? null` carries that to the formatter; `?? 0` would silently understate the wait.
	expect(PAGE).toMatch(
		/queued\s*\.?slice\(0, idx\)\s*\.?map\(\(e\) => mediaCatalog\.get\(e\.mediaId\)\?\.durationSec \?\? null\)/
	);
	// A playing song of unknown length makes the whole wait unknown, rather than contributing zero.
	expect(PAGE).toMatch(/if \(nowDurationSec <= 0\) return null;/);
});

test('the docked band reserves its band in flow instead of overlapping rows', () => {
	// The band's height is MEASURED and reserved in normal flow, never a constant: `.band-slot` measures ITSELF
	// and the layout takes that number back through `bind:bandH={dockH}` to stay the single publisher. Asserted
	// at every end, plus the negative — two writers of an inline `:root` property fight silently.
	// The measured height — taken off the rendered band row, then published by the LAYOUT.
	expect(DRAWER).toMatch(/<div class="band-slot"[^>]*bind:clientHeight=\{bandH\}>/);
	expect(LAYOUT).toMatch(/bind:bandH=\{dockH\}/);
	expect(LAYOUT).toMatch(/setProperty\(\s*'--dock-h'/);
	// MEASURED, not a constant, and this is where that word is falsifiable: the published value interpolates
	// the bound state rather than naming a height.
	expect(LAYOUT).toMatch(/setProperty\('--dock-h', `\$\{dockH\}px`\)/);
	expect(PAGE).not.toContain('bind:clientHeight');
	expect(PAGE).not.toContain('bind:bandH');
	expect(PAGE).not.toMatch(/setProperty\(\s*'--dock-h'/);
	// …and consumed by EVERY scrolling column. A constant here is the mockup's own bug: the docked band
	// occluded queue row 5 because a disclosure grew inside a fixed shell.
	for (const [where, src] of [['routes/+page.svelte', PAGE]] as const) {
		expect(src, `${where} must reserve the measured band in normal flow`).toMatch(
			/padding:\s*var\(--space-xs\) var\(--space-3xl\) calc\(var\(--dock-h[^)]*\) \+ 28px\)/
		);
	}
	// The drawer is mounted AFTER the children, so tab order follows visual order.
	expect(LAYOUT.indexOf('<NowPlayingDrawer')).toBeGreaterThan(LAYOUT.indexOf('{@render children()}'));
	// Nothing may dock off the retired sheet's token, or it reserves 132px of nothing.
	for (const src of [PAGE, LAYOUT, BAND]) expect(src).not.toContain('var(--peek-h)');
});

test('the now-playing band is docked for a joined singer, and the + Add a turn CTA is still gone', () => {
	// The docked-for-a-joined-singer requirement is asserted at the LAYOUT that mounts the band, since the band
	// is the bottom-most app chrome on every phone surface. The `+ Add a turn` interstitial stays retired.
	// Docked, gated on a joined singer, as ONE component: the drawer with the band composed inside it as snap 0.
	// Written with a bounded window rather than `[^>]*` because the tag's own props contain `>` (`() => goto(…)`),
	// so a negated-class run would stop at the first arrow rather than at the end of the tag.
	expect(LAYOUT).toMatch(/\{#if showBand\}\s*<NowPlayingDrawer\b[\s\S]{0,200}?bind:bandH=\{dockH\}/);
	expect(LAYOUT, 'the retired fade: no class, no rule, no state named `covered`').not.toContain('covered');
	expect(LAYOUT, 'the retired positioning wrapper — vaul fixes the drawer content itself').not.toContain(
		'class="dock"'
	);
	// The band is mounted by the DRAWER now, which is the only place it can be and still be snap 0.
	expect(DRAWER).toContain('<NowPlayingBand');
	// `showBand` is what carries "joined singer" — a guest on the landing page gets no band, and the
	// television (which is not a phone surface) gets none either.
	expect(LAYOUT).toMatch(/const showBand = \$derived\(isPhoneSurface && me !== null\)/);
	// THE MAGNIFIER IS RETIRED: the field is the FIRST element in the home column, so there is nothing for the
	// chrome to reach. Asserted as an ABSENCE because the failure mode is a half-restoration — a magnifier wired
	// to nothing, or a focus-request store nobody requests through.
	expect(LAYOUT, 'the band must not be given a search callback again').not.toContain('onsearch=');
	expect(LAYOUT, 'and the focus-request store retires with it').not.toContain('search-focus');

	// The CTA and its dock are GONE rather than re-gated, on every surface that could host them.
	for (const [where, src] of [
		['routes/+page.svelte', PAGE],
		['routes/+layout.svelte', LAYOUT]
	] as const) {
		expect(src, `${where}: the retired interstitial dock`).not.toContain('cta-dock');
		expect(src, `${where}: the retired interstitial button`).not.toMatch(/class="cta"/);
		expect(src, `${where}: the retired interstitial copy`).not.toContain('Add a turn');
		expect(src, `${where}: the retired browse push`).not.toContain('openBrowse');
		expect(src, `${where}: the retired browse toggle`).not.toContain('browseToggle');
	}

	// EXACTLY ONE, and the COUNT is the point: the single binding is a two-step publish, so both steps are
	// counted — one MEASUREMENT (`bind:clientHeight={bandH}`) and one HOP (`bind:bandH={dockH}`). A second of
	// either forks the geometry the measurement exists to keep single.
	const measured = DRAWER.match(/bind:clientHeight=\{bandH\}/g) ?? [];
	expect(measured.length).toBe(1);
	const hops = [LAYOUT, PAGE].join('\n').match(/bind:bandH=\{dockH\}/g) ?? [];
	expect(hops.length).toBe(1);
	// …and no phone surface measures a band of its own: ANY clientHeight binding here competes with the band's.
	for (const [where, src] of [
		['routes/+layout.svelte', LAYOUT],
		['routes/+page.svelte', PAGE]
	] as const)
		expect(src, `${where} must not measure a second docked band`).not.toContain('bind:clientHeight');
	// THE ONE-env() RULE: the inset lives on the BAND's padding and reaches everything above it THROUGH
	// --dock-h, which is bound to `.band-slot`'s clientHeight and so includes it. A second term ON or INSIDE
	// that measured element doubles the gap on a notched phone.
	const bandCss = BAND.slice(BAND.indexOf('.band {'), BAND.indexOf('.inner {'));
	expect((bandCss.match(/env\(safe-area-inset-bottom/g) ?? []).length).toBe(1);
	// Non-vacuity on the slices below: an unmatchable selector slices to nothing, and a `not.toContain`
	// over nothing passes while examining nothing.
	expect(DRAWER.indexOf('.band-slot {'), '.band-slot must still be the measured band row').toBeGreaterThan(-1);
	const slotCss = DRAWER.slice(DRAWER.indexOf('.band-slot {'), DRAWER.indexOf('.band-slot :global(.band)'));
	expect(slotCss.length).toBeGreaterThan(0);
	expect(slotCss).not.toContain('env(safe-area-inset-bottom');
	// The drawer CONTENT's own inset is not a second term: it is an ANCESTOR of `.band-slot`, so its padding is
	// outside the measured clientHeight, and it is bottom-most only while the sheet is pulled up — exactly when
	// the band is not. Counted, so a third cannot appear unnoticed.
	expect((DRAWER.match(/env\(safe-area-inset-bottom/g) ?? []).length).toBe(1);
	expect(LAYOUT, 'the layout declares no CSS at all now — vaul positions the content').not.toContain(
		'env(safe-area-inset-bottom'
	);
	for (const [where, src] of [['routes/+page.svelte', PAGE]] as const) {
		const mainCss = src.slice(src.indexOf('\tmain {'), src.indexOf('\tmain {') + 200);
		expect(mainCss, `${where} must still declare a top-level main rule`).toContain('padding:');
		expect(mainCss, `${where}'s reserve must not add a second env() term`).not.toContain('env(safe-area-inset-bottom');
	}
});

test('the results view is driven by the query on the find route, with no browse mode or ?browse=1', () => {
	// The split between the default and results views is driven purely by the QUERY, through `searchActive`
	// derived from it. A mode flag, a `?browse=1` push or a URL read is the defect this prohibits.
	expect(PAGE).toContain('const searchActive = $derived(query.trim().length > 0)');
	// The mode, its navigations, and the URL read that backed them are GONE from both phone routes.
	for (const [where, src] of [['routes/+page.svelte', PAGE]] as const) {
		expect(src, `${where} must not read a browse mode off the URL`).not.toContain("searchParams.get('browse')");
		expect(src, `${where} must not push the retired browse route`).not.toContain("goto('/?browse=1'");
		expect(src, `${where} must not declare a browse mode`).not.toContain('const browsing');
		expect(src, `${where} must not declare a browse mode`).not.toContain('function openBrowse');
		expect(src, `${where} must not declare a browse mode`).not.toContain('function closeBrowse');
		expect(src, `${where} must not gate on the retired mode`).not.toContain('!browsing');
	}
	// THE BACK ROLE: there is none. The results are a section of the page you are already on, so the only way
	// back is to stop searching. A `back` link is asserted ABSENT because it would point at the page rendering it.
	expect(PAGE).not.toMatch(/back=\{\{ href: '\/'/);
	expect(PAGE).not.toContain('data-testid="back-to-queue"');
	expect(PAGE).toMatch(/function clearSearch\(\)/);
	expect(PAGE).toMatch(/aria-label="Clear the search" onclick=\{clearSearch\}/);
	// The auto-scroll and its `resultShape` gate are GONE rather than re-gated: results grew UPWARD towards a box
	// pinned at the bottom. The box sits at the TOP now and results flow down, which needs no scrolling.
	expect(PAGE).not.toContain('resultShape');
	expect(PAGE).not.toMatch(/scrollTo\(|scrollIntoView\(/);
});

test('every result surface is gated on the query — an empty box shows the LIBRARY, never a stale list', () => {
	// One column with one query switch: an empty box is the queue AND the library, and a query gives the queue's
	// rows to the results. The bleed rule holds at full strength — library group ONLY with an empty box,
	// query-scoped groups ONLY with a query, both sides checked rather than weakened to "some gate exists".
	const main = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>'));

	// The query-scoped result groups (ready, raw, the no-results state) are gated on a query…
	const gated = main.match(/\{#if searchActive\b/g) ?? [];
	expect(gated.length).toBeGreaterThanOrEqual(1);
	// …and the zero-query view — the LIBRARY, not the queue — is gated on its absence.
	expect(main).toContain('{#if !searchActive}');
	expect(main).toContain('{#each libraryRows as m (m.id)}');
	// …and the queue is in the same column under the same switch: with one surface the no-disagreement rule is
	// satisfied by there being one list, gated on the query's absence.
	expect(main).toContain('<QueueRow');
	expect(main).toContain('{#each queued as e, i (e.id)}');

	// The retired mode must not linger anywhere in <main>.
	expect(main).not.toContain('{#if browsing');

	/*
	 * THE PROCESSING GROUP IS DELIBERATELY UNGATED: what is being made right now is equally relevant with an
	 * empty box. Not a lost gate — its MEMBERSHIP is query-scoped at the data layer by a pure helper fed
	 * `searchActive`, which decides row by row where a template gate could only hide the whole group, and also
	 * de-duplicates against whatever the queue on this surface is already drawing a live bar for.
	 */
	expect(main).toContain('{#if processingGroup.length}');
	expect(PAGE).toMatch(/processingGroupIds\(\{\s*searchActive,/);

	// Non-vacuity: every `<SongRow` in <main> really is inside one of those blocks — the first cannot precede
	// the first gate.
	const firstRow = main.indexOf('<SongRow');
	expect(firstRow).toBeGreaterThan(0);
	expect(main.indexOf('{#if !searchActive}')).toBeLessThan(firstRow);

	// THE BOX IS IN <main> AND AT THE TOP, in normal flow: the band owns the bottom edge, and two surfaces
	// fighting for one edge is the stack this route exists to unwind.
	expect(main).toContain('class="findbox"');
	const boxCss = PAGE.slice(PAGE.indexOf('.findbox {'), PAGE.indexOf('.findbox input {'));
	// NEITHER STICKY NOR FIXED. Sticky was tried and abandoned: PageHeader is already sticky and carries the top
	// safe-area inset, so a second sticky element needs the header's RENDERED height as its offset — not a
	// token, and an out-of-scale token makes the calc() invalid, sliding the box under the title silently.
	expect(boxCss).not.toMatch(/position:\s*(?:sticky|fixed)/);
	// The retired address is gone rather than merely unscanned.
	expect(PAGE).not.toContain('search-dock');
	expect(PAGE).not.toContain('search-dock');
});

test('both row kinds are told WHICH mutation they are waiting on', () => {
	const wired = PAGE.match(/pending=\{pendingKind\.get\(e\.id\) \?\? null\}/g) ?? [];
	expect(wired.length).toBe(2); // QueueRow and ProcessingCard
	// Both hops since the room-link hoist: the link re-reads the kind map off the QueueStore it now
	// owns, and the page mirrors the link's copy. Either hop breaking is the same stale-marker defect.
	expect(read('src/lib/stores/room.ts')).toMatch(/this\.pendingKind = this\.queue!\.pendingKindById/);
	expect(PAGE).toMatch(/pendingKind = room\.pendingKind/);
});

test('the shell imports what it is built from — a missing one is a build break, not a test break', () => {
	// Nothing imports this route, so reverting an import reds `build`/`typecheck` and leaves the suite green.
	// Each is pinned here as the syntax claim it is. The `$app/state` `page` import is GONE because the results
	// view is query-driven in place. (Asserted on the specifier alone, so this comment cannot read as an import.)
	expect(PAGE).not.toContain('$app/state');
	// `waitShort` replaced `positionWords` with the card that read it, and the search surface brought the row
	// component and the readiness helpers the result groups call. Each is a build break if dropped.
	expect(PAGE).toMatch(/import \{ waitShort \} from '\$lib\/phrasing\/position-sentence';/);
	expect(PAGE).not.toContain('MyPositionCard');
	expect(PAGE).not.toContain('search-focus');
	expect(PAGE).toMatch(/import SongRow from '\$lib\/components\/SongRow\.svelte';/);
	expect(PAGE).toMatch(/import \{ processAndQueue \} from '\$lib\/process-and-queue';/);
	// The layout has no unit harness either, so a dropped import reds `build`/`typecheck` and leaves the suite
	// green. Its own `import NowPlayingBand` is UNREFERENCED, so this asserts neither its presence (pinning dead
	// code) nor its absence (demanding a source edit from a guard).
	expect(LAYOUT).toMatch(/import NowPlayingDrawer from '\$lib\/components\/NowPlayingDrawer\.svelte';/);
	expect(DRAWER).toMatch(/import NowPlayingBand from '\$lib\/components\/NowPlayingBand\.svelte';/);
	// songDisplay is what keeps the song's title and artist APART — `mediaTitle` welds them together, and the
	// uploader once ended up rendered as the artist. Asserted against the IMPORT LIST, not the file: the call
	// site mentions the name too, so a file-wide scan stays green with the import removed.
	const shared = LAYOUT.slice(LAYOUT.indexOf('import {'), LAYOUT.indexOf("} from '$lib/contract';"));
	expect(shared).toMatch(/(^|[\s,])songDisplay\s*(,|$)/m);
	// …and the byline keeps the uploader fallback, or the drawer and the band both show no artist for every song
	// whose parse was not confident — which is most local files.
	expect(LAYOUT).toMatch(/display\.artist \?\? media\?\.artist \?\? null/);
});

test('the route no longer declares the transport styles the drawer now owns', () => {
	// A PURE DELETION, so reverting it re-adds rules nothing selects while the suite stays green. Two arms,
	// because the finding is not only "unused": the block held four of this route's `44px` literals.
	expect(PAGE).not.toMatch(/^\s*\.ic\s*\{/m);
	expect(PAGE).not.toMatch(/^\s*\.ic\.play\s*\{/m);
	expect(PAGE).not.toMatch(/^\s*\.ic:disabled\s*\{/m);
	// …and no markup left behind that would have needed them, nor a second copy of the transport's new rule.
	expect(PAGE).not.toContain('class="ic ');
	expect(PAGE).not.toContain('no-drag');
	expect(PAGE).not.toMatch(/^\s*\.transport\s*\{/m);
	// THE BAND OWNS THE TRANSPORT: the controls this route gave up really render somewhere, sized from the token
	// rather than the number. Restart and skip sit beside the disc as one cluster, unconditionally — every
	// arrangement that kept them apart was reported as the controls not being unified.
	const BAND_SRC = read('src/lib/components/NowPlayingBand.svelte');
	expect(BAND_SRC).toContain('aria-label="Restart"');
	expect(BAND_SRC).toContain('aria-label="skip"');
	// …in ONE group with the disc, which is the whole point of the move. Order matters: prev·play·next.
	expect(BAND_SRC).toMatch(
		/<div class="tp"[^>]*>[\s\S]*aria-label="Restart"[\s\S]*class="disc"[\s\S]*aria-label="skip"[\s\S]*<\/div>/
	);
	// …and visible at BOTH heights: exactly three controls in the group, none conditionally rendered.
	const tpGroup = /<div class="tp"[\s\S]*?<\/div>\s*<\/div>/.exec(BAND_SRC)?.[0] ?? '';
	expect(tpGroup.length, 'the transport group must be found to be counted').toBeGreaterThan(200);
	expect((tpGroup.match(/<button/g) ?? []).length, 'restart, the disc, skip — and nothing else').toBe(3);
	expect(tpGroup, 'none of the three may be gated on a height or a mode').not.toMatch(/\{#if/);
	// The sheet must NOT grow its own copy of any of the three back again.
	for (const gone of ['class="transport"', 'data-transport="play"'])
		expect(DRAWER, `the sheet must not carry \`${gone}\` — the band row is the transport`).not.toContain(gone);
	// READ OFF THE COMMENT-STRIPPED SOURCE: `44px` is an assertion about a DECLARATION, and the drawer's
	// snap-point rationale records a measured symptom in an "844px viewport", which CONTAINS that substring. A
	// literal-versus-token claim can only be about code.
	expect(DRAWER).not.toContain('44px');
	// Non-vacuity: the stripped text really is the production file, anchored on the band row it composes, so
	// the negative above examines something rather than an empty string.
	expect(DRAWER).toContain('class="band-slot"');
});

test('everything docked measures from --dock-h, and the rationale names that token', () => {
	// A comment that contradicts its code is a defect class here, and this rationale is load-bearing prose: it
	// tells the next author that the safe-area inset arrives THROUGH the token, so a second env() term doubles
	// the gap. Naming the retired --peek-h would send them to a component this route no longer mounts.
	const stack = RAW.slice(RAW.indexOf('Docked-toast stacking'), RAW.indexOf('--error-dock:'));
	expect(stack).toContain('--dock-h');
	expect(stack).not.toContain('--peek-h');
	expect(PAGE).toMatch(/--undo-dock:\s*calc\(var\(--dock-h[^)]*\) \+ 14px\)/);
});

test('no media query overrides the docked band height — the measurement outranks it', () => {
	// An inline custom property on :root BEATS a stylesheet rule, so an override here is silently defeated the
	// moment the effect writes the real height — a rule that looks like it does something and does not.
	const short = PAGE.slice(PAGE.indexOf('@media (max-height: 480px)'));
	expect(short.length).toBeGreaterThan(0);
	expect(short).not.toContain('--dock-h:');
	expect(short).not.toContain('--peek-h:');
	// non-vacuity: the block still shrinks the top chrome, which is what it is for.
	expect(short).toContain('.topbar');
});
