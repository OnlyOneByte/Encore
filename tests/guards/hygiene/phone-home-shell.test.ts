// Wiring guards for the phone home shell: which component renders where, what is gated on what, which value is
// fed to which prop. A SOURCE SCAN because `routes/+page.svelte` imports `$app/navigation` and `$app/state`, so
// it cannot be mounted at all; every MEASUREMENT claim is in phone-home.test.ts instead. These are the
// assertions that RED when a relocation hunk is reverted, since nothing imports the route.
//
// The shape they describe: `NowPlayingBand` is composed inside `NowPlayingDrawer` as snap point 0 of a
// permanently-mounted sheet, the LAYOUT is the single writer of `--dock-h`, search is a field at the top of `/`
// with the library under the queue, and `searchActive` is the only switch. There is no now-playing card on
// home, no `.dock` wrapper, no `drawerOpen` and no `onexpand`. See docs/GUARDS.md#the-hygiene-and-meta-guards.
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
const LAYOUT = stripComments(read('src/routes/+layout.svelte'));
const BAND = stripComments(read('src/lib/components/NowPlayingBand.svelte'));
const DRAWER = stripComments(read('src/lib/components/NowPlayingDrawer.svelte'));
const DRAWER_CONTENT = stripComments(read('src/lib/components/ui/drawer/drawer-content.svelte'));
const DRAWER_HANDLE = stripComments(read('src/lib/components/ui/drawer/drawer-handle.svelte'));

test('home renders NO now-playing surface — the layout owns the drawer, and the queue sheet stays gone', () => {
	// Three claims, each falsifiable alone, together saying there is EXACTLY ONE now-playing surface and it is
	// reachable: (a) the hero COMPONENT is gone from the TREE, so no surviving import can re-mount it; (b) home
	// mounts none of any kind, so it cannot grow a second and disagree with the layout's; (c) the drawer is
	// mounted once with the band composed INSIDE it — a drawer with no band is the defect a count alone misses.
	expect(existsSync(at('src/lib/components/NowPlayingHero.svelte'))).toBe(false);
	for (const surface of ['NowPlayingHero', 'NowPlayingBand', 'NowPlayingDrawer'])
		expect(PAGE, `home must not mount \`${surface}\`: the layout is the one owner`).not.toContain(surface);
	expect(LAYOUT).toMatch(/import NowPlayingDrawer from '\$lib\/components\/NowPlayingDrawer\.svelte';/);
	expect((LAYOUT.match(/<NowPlayingDrawer\b/g) ?? []).length).toBe(1);
	expect(LAYOUT, 'a permanently-mounted sheet has no open state').not.toMatch(/\bdrawerOpen\b/);
	expect(LAYOUT, 'the band raises nothing now — it IS the sheet at snap 0').not.toContain('onexpand');
	expect(LAYOUT, 'the layout mounts the drawer; the drawer mounts the band').not.toContain('<NowPlayingBand');
	// …and the band really is in there, once, as the content's FIRST child, ordered against the header so "first
	// child" is a claim rather than a hope. The drag affordance in that slot is vaul's own Handle: a click cannot
	// track a thumb, which is what the band's old click-only button could never be.
	expect((DRAWER.match(/<NowPlayingBand\b/g) ?? []).length).toBe(1);
	expect(DRAWER).toMatch(/<div class="band-slot"[^>]*bind:clientHeight=\{bandH\}>/);
	expect(DRAWER.indexOf('class="band-slot"')).toBeGreaterThan(-1);
	expect(DRAWER.indexOf('class="band-slot"')).toBeLessThan(DRAWER.indexOf('<Drawer.Header'));
	expect(DRAWER).toMatch(/<div class="band-slot"[\s\S]{0,200}?<Drawer\.Handle \/>/);

	for (const [where, src] of [
		['routes/+page.svelte', PAGE],
		['routes/+layout.svelte', LAYOUT],
		['NowPlayingDrawer.svelte', DRAWER]
	] as const) {
		expect(src, `${where}: the retired queue sheet`).not.toContain('QueueSheet');
	}
});

test('the rotation rows render inside <main>, not inside a pull-up sheet', () => {
	// Sliced from the OPENING TAG, not the literal `<main>`: the element carries a style attribute (`--row-h`), so
	// the bare-tag literal stopped matching and this compared an empty string against every expectation.
	const main = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>'));
	expect(main).toContain('{#each queued as e, i (e.id)}');
	expect(main).toContain('<QueueRow');
	expect(main).toContain('<ProcessingCard');
	// The `{#if !searchActive}` gate keeps a result list from stacking over the rotation, and it is asserted on
	// BOTH sides: the rows behind that gate, and the rows still behind the joined branch (`{#if me}`, whose
	// else-arm is the landing page) so a guest gets the landing page rather than a bare queue.
	const joinedStart = main.indexOf('{#if me}');
	expect(joinedStart).toBeGreaterThanOrEqual(0);
	expect(main.indexOf('{#each queued as e, i (e.id)}')).toBeGreaterThan(joinedStart);
	expect(main).toContain('<JoinLanding />');
	const zeroQuery = main.indexOf('{#if !searchActive}');
	expect(zeroQuery).toBeGreaterThan(joinedStart);
	expect(main.indexOf('{#each queued as e, i (e.id)}')).toBeGreaterThan(zeroQuery);
	expect(PAGE).toContain('<SongRow');
	expect(PAGE).toContain('searchActive');
	expect(PAGE).toContain('findbox');
});

test('the live singing controls live in the DRAWER, which IS the revealing, and home carries none', () => {
	// The drawer IS the act of revealing, so a disclosure inside it is a second tap to see what the first was for.
	// Five claims: (1) all four controls sit inside `.tools-body`; (2) that body is gated on a song playing NOW;
	// (3) the guiding-track slider does not share a drag surface with the dismiss gesture, with a real vaul Handle
	// pinned alongside the restriction; (4) the range sits DIRECTLY below the key row; (5) home carries none.
	// (1) THE SLICE COUNTS NESTING: stopping at the first `</div>` is correct only while `.tools-body` has no
	// nested block, and a guard reporting a false absence is worse than one reporting none.
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
	expect(toolsBody).toContain('<GuidingTrack');
	expect(toolsBody).toContain('<RangeBar');
	expect(toolsBody).toContain('class="key"');
	expect(toolsBody, 'the sheet must not carry the re-selection control').not.toContain('<LyricsReselect');
	expect(toolsBody, 'the lyrics source must still be named').toContain('class="lyricsrc"');
	expect(DRAWER, 'the pill must read the shared contract label, not a local copy of the strings').toContain(
		'lyricsSourceLabel('
	);
	expect(read('src/routes/song/[mediaId]/+page.svelte')).toContain('<LyricsReselect');
	expect(toolsBody).toContain('class="tools-note"');

	const hasSongGate = DRAWER.indexOf('{#if hasSong}');
	expect(hasSongGate).toBeGreaterThan(-1);
	expect(hasSongGate).toBeLessThan(DRAWER.indexOf('<div class="tools-body">'));
	for (const gone of ['class="transport"', 'data-transport="play"', 'aria-label="play/pause"'])
		expect(DRAWER, `the sheet must not carry \`${gone}\` again — the band row is the transport`).not.toContain(gone);
	expect(DRAWER, 'and the band it composes is where the transport lives').toContain('<NowPlayingBand');
	for (const wire of ['onrestart={onrestart}', 'onskip={onskip}', 'ontoggleplay={ontoggleplay}'])
		expect(DRAWER, `the band lost its \`${wire}\` wiring`).toContain(wire);
	// THE REVEAL IS RETIRED and its ABSENCE is pinned: restart and skip were hidden in the collapsed bar only
	// because the magnifier shared the band row, and the magnifier is gone. So the transport must be
	// UNCONDITIONAL and must not go back behind a height state in any of the shapes already tried.
	expect(DRAWER, 'the reveal is retired — no height class may be toggled onto the band again').not.toMatch(
		/classList\.(toggle|add)\('sheet-(up|down)'/
	);
	expect(DRAWER, 'and no wrapper may be reintroduced to hold one').not.toContain('class="band-face"');
	const BAND_CODE = stripComments(read('src/lib/components/NowPlayingBand.svelte'));
	expect(BAND_CODE, 'the pair must not be hidden at rest again').not.toMatch(/display:\s*none/);
	expect(BAND_CODE, 'and the class the hiding rule keyed on stays gone, so nothing can re-hide by name').not.toContain(
		'tp-side'
	);
	// THE MEASURED CONSTRAINT THAT OUTLIVES THE REVEAL: the band cannot take a prop that CHANGES after mount, and
	// a reactive class directive on the band face is the same defect — `.band-slot` carries `bind:clientHeight`,
	// so any reactive update re-runs its size binding into the mount rung's throw.
	expect(DRAWER, 'the sheet-up class must not come back as a reactive directive').not.toMatch(/class:sheet-up=/);
	expect(DRAWER, 'and must not come back as $state written from an effect either').not.toMatch(/let sheetUp = \$state/);
	expect(DRAWER, 'the band must not be given an expanded/sheetUp prop').not.toMatch(
		/<NowPlayingBand[\s\S]*?(?:expanded|sheetUp)=/
	);

	// (3) The whole BAND ROW takes hold of the sheet and the exclusion is INVERTED: `data-vaul-no-drag` on
	// `.np-fit`, which vaul resolves with `closest()`, covers head, body, slider, keycaps and visualiser in one
	// attribute — so a control added to the sheet is excluded by construction. BOTH halves: `handleOnly` GONE,
	// and the attribute on the WRAPPER rather than anywhere.
	expect(DRAWER, 'handleOnly is retired — the band row is the drag surface').not.toMatch(
		/<Drawer\.Root\b[^>]*\bhandleOnly\b/
	);
	expect(DRAWER, 'the sheet body must be excluded from dragging').toMatch(/<div class="np-fit" data-vaul-no-drag\b/);
	const BAND_DRAG = read('src/lib/components/NowPlayingBand.svelte');
	expect(BAND_DRAG, 'the transport group must not be a drag surface').toMatch(/<div class="tp" data-vaul-no-drag>/);
	expect(BAND_DRAG, 'and there must be no control in the row outside that protection').not.toContain(
		'aria-label="Search for a song"'
	);
	expect(BAND_DRAG, 'a drag must not count as a tap on the metadata block').toContain('if (dragged) return;');
	// …and a REAL handle for it to be restricted to: without one the restriction is a silent no-op that makes the drawer
	// undraggable. The vendored content file must not render a competing one — two stacked grab bars shipped once.
	expect(DRAWER).toMatch(/<Drawer\.Handle\b/);
	expect(DRAWER_CONTENT).not.toMatch(/<DrawerHandle\b/);
	expect(DRAWER_HANDLE).toMatch(/<DrawerPrimitive\.Handle\b/);
	expect(DRAWER).not.toContain('Collapsible');

	expect(toolsBody.indexOf('class="key"')).toBeLessThan(toolsBody.indexOf('<div class="range">'));

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
	expect(PAGE).toMatch(/if \(nowDurationSec <= 0\) return null;/);
});

test('the docked band reserves its band in flow instead of overlapping rows', () => {
	// The band's height is MEASURED and reserved in normal flow, never a constant: `.band-slot` measures ITSELF and the
	// layout takes that number back through `bind:bandH={dockH}` to stay the single publisher, which is falsifiable
	// because the published value interpolates the bound state rather than naming a height. Asserted at every end plus
	// the negative — two writers of an inline `:root` property fight silently.
	expect(DRAWER).toMatch(/<div class="band-slot"[^>]*bind:clientHeight=\{bandH\}>/);
	expect(LAYOUT).toMatch(/bind:bandH=\{dockH\}/);
	expect(LAYOUT).toMatch(/setProperty\(\s*'--dock-h'/);
	expect(LAYOUT).toMatch(/setProperty\('--dock-h', `\$\{dockH\}px`\)/);
	expect(PAGE).not.toContain('bind:clientHeight');
	expect(PAGE).not.toContain('bind:bandH');
	expect(PAGE).not.toMatch(/setProperty\(\s*'--dock-h'/);
	for (const [where, src] of [['routes/+page.svelte', PAGE]] as const) {
		expect(src, `${where} must reserve the measured band in normal flow`).toMatch(
			/padding:\s*var\(--space-xs\) var\(--space-3xl\) calc\(var\(--dock-h[^)]*\) \+ 28px\)/
		);
	}
	expect(LAYOUT.indexOf('<NowPlayingDrawer')).toBeGreaterThan(LAYOUT.indexOf('{@render children()}'));
	for (const src of [PAGE, LAYOUT, BAND]) expect(src).not.toContain('var(--peek-h)');
});

test('the now-playing band is docked for a joined singer, and the + Add a turn CTA is still gone', () => {
	// Asserted at the LAYOUT that mounts the band, since the band is the bottom-most app chrome on every phone
	// surface. Docked, gated on a joined singer, as ONE component: the drawer with the band inside it as snap 0.
	// A bounded window rather than `[^>]*` because the tag's own props contain `>` (`() => goto(…)`), so a
	// negated-class run would stop at the first arrow rather than at the end of the tag.
	expect(LAYOUT).toMatch(/\{#if showBand\}\s*<NowPlayingDrawer\b[\s\S]{0,200}?bind:bandH=\{dockH\}/);
	expect(LAYOUT, 'the retired fade: no class, no rule, no state named `covered`').not.toContain('covered');
	expect(LAYOUT, 'the retired positioning wrapper — vaul fixes the drawer content itself').not.toContain(
		'class="dock"'
	);
	expect(DRAWER).toContain('<NowPlayingBand');
	expect(LAYOUT).toMatch(/const showBand = \$derived\(isPhoneSurface && me !== null\)/);
	// THE MAGNIFIER IS RETIRED: the field is the FIRST element in the home column, so there is nothing for the
	// chrome to reach. An ABSENCE because the failure mode is a half-restoration — a magnifier wired to nothing,
	// or a focus-request store nobody requests through.
	expect(LAYOUT, 'the band must not be given a search callback again').not.toContain('onsearch=');
	expect(LAYOUT, 'and the focus-request store retires with it').not.toContain('search-focus');

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

	// EXACTLY ONE, and the COUNT is the point: the publish is two steps, so both are counted — one MEASUREMENT
	// (`bind:clientHeight={bandH}`) and one HOP (`bind:bandH={dockH}`). A second of either forks the geometry.
	const measured = DRAWER.match(/bind:clientHeight=\{bandH\}/g) ?? [];
	expect(measured.length).toBe(1);
	const hops = [LAYOUT, PAGE].join('\n').match(/bind:bandH=\{dockH\}/g) ?? [];
	expect(hops.length).toBe(1);
	for (const [where, src] of [
		['routes/+layout.svelte', LAYOUT],
		['routes/+page.svelte', PAGE]
	] as const)
		expect(src, `${where} must not measure a second docked band`).not.toContain('bind:clientHeight');
	// THE ONE-env() RULE: the inset lives on the BAND's padding and reaches everything above it THROUGH --dock-h,
	// which is bound to `.band-slot`'s clientHeight and so includes it. A second term ON or INSIDE that measured
	// element doubles the gap on a notched phone.
	const bandCss = BAND.slice(BAND.indexOf('.band {'), BAND.indexOf('.inner {'));
	expect((bandCss.match(/env\(safe-area-inset-bottom/g) ?? []).length).toBe(1);
	expect(DRAWER.indexOf('.band-slot {'), '.band-slot must still be the measured band row').toBeGreaterThan(-1);
	const slotCss = DRAWER.slice(DRAWER.indexOf('.band-slot {'), DRAWER.indexOf('.band-slot :global(.band)'));
	expect(slotCss.length).toBeGreaterThan(0);
	expect(slotCss).not.toContain('env(safe-area-inset-bottom');
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
	expect(PAGE).toContain('const searchActive = $derived(query.trim().length > 0)');
	for (const [where, src] of [['routes/+page.svelte', PAGE]] as const) {
		expect(src, `${where} must not read a browse mode off the URL`).not.toContain("searchParams.get('browse')");
		expect(src, `${where} must not push the retired browse route`).not.toContain("goto('/?browse=1'");
		expect(src, `${where} must not declare a browse mode`).not.toContain('const browsing');
		expect(src, `${where} must not declare a browse mode`).not.toContain('function openBrowse');
		expect(src, `${where} must not declare a browse mode`).not.toContain('function closeBrowse');
		expect(src, `${where} must not gate on the retired mode`).not.toContain('!browsing');
	}
	// THE BACK ROLE: there is none. The results are a section of the page you are already on, so a `back` link is
	// asserted ABSENT — it would point at the page rendering it.
	expect(PAGE).not.toMatch(/back=\{\{ href: '\/'/);
	expect(PAGE).not.toContain('data-testid="back-to-queue"');
	expect(PAGE).toMatch(/function clearSearch\(\)/);
	expect(PAGE).toMatch(/aria-label="Clear the search" onclick=\{clearSearch\}/);
	expect(PAGE).not.toContain('resultShape');
	expect(PAGE).not.toMatch(/scrollTo\(|scrollIntoView\(/);
});

test('every result surface is gated on the query — an empty box shows the LIBRARY, never a stale list', () => {
	// One column with one query switch: an empty box is the queue AND the library, and a query gives the queue's
	// rows to the results. BOTH sides are checked rather than weakened to "some gate exists" — the library group
	// ONLY with an empty box, the query-scoped groups ONLY with a query.
	const main = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>'));

	const gated = main.match(/\{#if searchActive\b/g) ?? [];
	expect(gated.length).toBeGreaterThanOrEqual(1);
	expect(main).toContain('{#if !searchActive}');
	expect(main).toContain('{#each libraryRows as m (m.id)}');
	expect(main).toContain('<QueueRow');
	expect(main).toContain('{#each queued as e, i (e.id)}');

	expect(main).not.toContain('{#if browsing');

	// THE PROCESSING GROUP IS DELIBERATELY UNGATED: what is being made right now is equally relevant with an empty
	// box. Not a lost gate — its MEMBERSHIP is query-scoped at the data layer by a pure helper fed `searchActive`,
	// which decides row by row where a template gate could only hide the whole group, and de-duplicates against
	// whatever the queue is already drawing a live bar for.
	expect(main).toContain('{#if processingGroup.length}');
	expect(PAGE).toMatch(/processingGroupIds\(\{\s*searchActive,/);

	// Non-vacuity: the first `<SongRow` in <main> cannot precede the first gate.
	const firstRow = main.indexOf('<SongRow');
	expect(firstRow).toBeGreaterThan(0);
	expect(main.indexOf('{#if !searchActive}')).toBeLessThan(firstRow);

	expect(main).toContain('class="findbox"');
	const boxCss = PAGE.slice(PAGE.indexOf('.findbox {'), PAGE.indexOf('.findbox input {'));
	// NEITHER STICKY NOR FIXED. Sticky was tried and abandoned: PageHeader is already sticky and carries the top
	// safe-area inset, so a second sticky element needs the header's RENDERED height as its offset — not a token, and
	// an out-of-scale token makes the calc() invalid, sliding the box under the title silently.
	expect(boxCss).not.toMatch(/position:\s*(?:sticky|fixed)/);
	expect(PAGE).not.toContain('search-dock');
});

test('both row kinds are told WHICH mutation they are waiting on', () => {
	const wired = PAGE.match(/pending=\{pendingKind\.get\(e\.id\) \?\? null\}/g) ?? [];
	expect(wired.length).toBe(2); // QueueRow and ProcessingCard
	expect(read('src/lib/stores/room.ts')).toMatch(/this\.pendingKind = this\.queue!\.pendingKindById/);
	expect(PAGE).toMatch(/pendingKind = room\.pendingKind/);
});

test('the shell imports what it is built from — a missing one is a build break, not a test break', () => {
	// Nothing imports this route, so reverting an import reds `build`/`typecheck` and leaves the suite green. Each
	// is pinned here as the syntax claim it is. The `$app/state` `page` import is GONE because the results view is
	// query-driven in place; asserted on the specifier alone, so this comment cannot read as an import.
	expect(PAGE).not.toContain('$app/state');
	expect(PAGE).toMatch(/import \{ waitShort \} from '\$lib\/phrasing\/position-sentence';/);
	expect(PAGE).not.toContain('MyPositionCard');
	expect(PAGE).not.toContain('search-focus');
	expect(PAGE).toMatch(/import SongRow from '\$lib\/components\/SongRow\.svelte';/);
	expect(PAGE).toMatch(/import \{ processAndQueue \} from '\$lib\/process-and-queue';/);
	// The layout has no unit harness either. Its own `import NowPlayingBand` is UNREFERENCED, so this asserts
	// neither its presence (pinning dead code) nor its absence (demanding a source edit from a guard).
	expect(LAYOUT).toMatch(/import NowPlayingDrawer from '\$lib\/components\/NowPlayingDrawer\.svelte';/);
	expect(DRAWER).toMatch(/import NowPlayingBand from '\$lib\/components\/NowPlayingBand\.svelte';/);
	// songDisplay keeps the song's title and artist APART — `mediaTitle` welds them, and the uploader once ended
	// up rendered as the artist. Asserted against the IMPORT LIST, not the file: the call site mentions the name
	// too, so a file-wide scan stays green with the import removed.
	const shared = LAYOUT.slice(LAYOUT.indexOf('import {'), LAYOUT.indexOf("} from '$lib/contract';"));
	expect(shared).toMatch(/(^|[\s,])songDisplay\s*(,|$)/m);
	// …and the byline keeps the uploader fallback, or both show no artist for every song whose parse was not
	// confident — most local files.
	expect(LAYOUT).toMatch(/display\.artist \?\? media\?\.artist \?\? null/);
});

test('the route no longer declares the transport styles the drawer now owns', () => {
	// A PURE DELETION, so reverting it re-adds rules nothing selects while the suite stays green. Two arms, because
	// the finding is not only "unused": the block held four of this route's `44px` literals.
	expect(PAGE).not.toMatch(/^\s*\.ic\s*\{/m);
	expect(PAGE).not.toMatch(/^\s*\.ic\.play\s*\{/m);
	expect(PAGE).not.toMatch(/^\s*\.ic:disabled\s*\{/m);
	expect(PAGE).not.toContain('class="ic ');
	expect(PAGE).not.toContain('no-drag');
	expect(PAGE).not.toMatch(/^\s*\.transport\s*\{/m);
	// THE BAND OWNS THE TRANSPORT: the controls this route gave up really render somewhere, sized from the token rather
	// than the number. Restart and skip sit beside the disc as one cluster in order (prev·play·next), unconditionally —
	// every arrangement that kept them apart was reported as the controls not being unified — and exactly three
	// controls are in the group, none conditionally rendered.
	const BAND_SRC = read('src/lib/components/NowPlayingBand.svelte');
	expect(BAND_SRC).toContain('aria-label="Restart"');
	expect(BAND_SRC).toContain('aria-label="skip"');
	expect(BAND_SRC).toMatch(
		/<div class="tp"[^>]*>[\s\S]*aria-label="Restart"[\s\S]*class="disc"[\s\S]*aria-label="skip"[\s\S]*<\/div>/
	);
	const tpGroup = /<div class="tp"[\s\S]*?<\/div>\s*<\/div>/.exec(BAND_SRC)?.[0] ?? '';
	expect(tpGroup.length, 'the transport group must be found to be counted').toBeGreaterThan(200);
	expect((tpGroup.match(/<button/g) ?? []).length, 'restart, the disc, skip — and nothing else').toBe(3);
	expect(tpGroup, 'none of the three may be gated on a height or a mode').not.toMatch(/\{#if/);
	for (const gone of ['class="transport"', 'data-transport="play"'])
		expect(DRAWER, `the sheet must not carry \`${gone}\` — the band row is the transport`).not.toContain(gone);
	// READ OFF THE COMMENT-STRIPPED SOURCE: `44px` is an assertion about a DECLARATION, and the drawer's
	// snap-point rationale records a measured symptom in an "844px viewport", which CONTAINS that substring.
	expect(DRAWER).not.toContain('44px');
	expect(DRAWER).toContain('class="band-slot"');
});

test('everything docked measures from --dock-h, and the rationale names that token', () => {
	// This rationale is LOAD-BEARING PROSE IN THE SOURCE: it tells the next author that the safe-area inset
	// arrives THROUGH the token, so a second env() term doubles the gap. Naming the retired --peek-h would send
	// them to a component this route no longer mounts.
	const stack = RAW.slice(RAW.indexOf('Docked-toast stacking'), RAW.indexOf('--error-dock:'));
	expect(stack).toContain('--dock-h');
	expect(stack).not.toContain('--peek-h');
	expect(PAGE).toMatch(/--undo-dock:\s*calc\(var\(--dock-h[^)]*\) \+ 14px\)/);
});

test('no media query overrides the docked band height — the measurement outranks it', () => {
	const short = PAGE.slice(PAGE.indexOf('@media (max-height: 480px)'));
	expect(short.length).toBeGreaterThan(0);
	expect(short).not.toContain('--dock-h:');
	expect(short).not.toContain('--peek-h:');
	// non-vacuity: the block still shrinks the top chrome, which is what it is for.
	expect(short).toContain('.topbar');
});
