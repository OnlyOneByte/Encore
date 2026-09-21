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
//
// ══ THE DRAWER PHASE, AND WHAT IT REVERSED (§4) ═════════════════════════════════════════════════
//
// Two further arms pinned a DESIGN DECISION that has now flipped outright. It is recorded here rather
// than dropped, because the arms it produced were correct about the phone they were written for:
//
//   4. HOME HAS NO NOW-PLAYING SURFACE. `NowPlayingHero` is DELETED, and its job — the song identity,
//      the seek row, the transport, and the live singing controls — moved into `NowPlayingDrawer`, a
//      bottom drawer mounted in `routes/+layout.svelte` and opened by the band's pull handle. Home is
//      QUEUE-ONLY. The hero was direction A's answer to "where is the song I am singing", and the band
//      phase made it a duplicate: the band already states the song, the singer and the progress at a
//      glance from EVERY phone surface, so a card restating all of it cost the rotation the top of the
//      screen for nothing. Two arms move with it — "home renders the HERO" and "the controls came WITH
//      the hero, into its DISCLOSURE BODY" — and both are replaced at greater strength rather than
//      re-pointed, because the new arrangement supports claims the old one could not make.
//
//      XR-PH-15's SUBSTANCE SURVIVES UNCHANGED and is still pinned: a control must not share a drag
//      surface. The hero satisfied it by having no drag surface at all. The drawer HAS one — vaul drags
//      to dismiss from anywhere in its content by default — and its body is sliders, so the guiding
//      track's thumb and the dismiss gesture would be the same gesture, with the drawer winning because
//      it is the ancestor. `handleOnly` on the Root is the answer: dragging is restricted to the handle,
//      a whitelist that cannot be forgotten when the next control is added. So `handleOnly` is asserted
//      HERE, and so is the real vaul Handle it restricts dragging TO — shadcn's copy-in shipped a
//      decorative div, and `handleOnly` with no `data-vaul-handle` in the tree makes the drawer silently
//      undraggable, which is a worse failure than the one it prevents.
//
//      THE DISCLOSURE IS GONE, not relocated. The hero needed one because it lived permanently on home;
//      the drawer IS the act of revealing, so a disclosure inside it would be a second tap to see what
//      the first tap was for. The nested "Vocal range" disclosure went with it: the range visualizer now
//      sits DIRECTLY BELOW the key row, which is what it answers about.
//
// ══ THE MERGE PHASE, AND WHAT IT REVERSED (§5) ══════════════════════════════════════════════════
//
// §1 and §4 above are both written about a phone with TWO bottom surfaces — a docked band, and a drawer
// it raised through a callback. There is ONE now, at two heights, and the arms that described the pair
// are re-pointed or retired below rather than dropped:
//
//   5. THERE IS NO `.dock` WRAPPER, NO `drawerOpen`, AND NO `onexpand`. `NowPlayingBand` is COMPOSED
//      inside `NowPlayingDrawer` as the first child of its content (`.band-slot`), which is snap point
//      0 of a permanently-mounted vaul sheet, and vaul supplies the `position: fixed; bottom: 0` the
//      wrapper used to. So the layout mounts one component, and the two-surface handshake —
//      `let drawerOpen = $state(false)`, `bind:open={drawerOpen}`, `onexpand={() => (drawerOpen =
//      true)}` — is BANNED rather than re-pointed: a sheet that never closes has no open state, and a
//      band that IS the sheet needs nothing to raise it. What forced the change is a gesture: an
//      outside element can START a pointer gesture but cannot hand the in-flight pointer to vaul, so
//      the old band's handle advertised a drag it could only answer with a jump.
//
//      THE `class:covered={drawerOpen}` FADE IS RETIRED, and it is the one mechanism here that loses
//      its assertions outright. It existed only because two surfaces of the same colour with matching
//      top edges had to step out from under each other for the length of the open; one surface at two
//      heights has nothing to hide. Its `opacity`-never-`visibility` rider goes with it — the docked-
//      band arm below records that deletion where the assertion used to be.
//
//      `--dock-h` KEEPS ITS MEANING AND ITS SINGLE WRITER, published in two named steps instead of one
//      binding: `.band-slot` measures itself with `bind:clientHeight={bandH}` inside the drawer (that
//      height IS snap 0), the layout takes it back with `bind:bandH={dockH}`, and the layout alone
//      calls `setProperty('--dock-h', …)` and removes it on teardown. `showBand` keeps its name and its
//      definition, so the "joined singer on a phone surface" gate is unchanged.
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
// The three surfaces the shell was split across. Read here so every arm asserts what is actually
// there: the layout owns the band and the token, the find route owns search, the band owns the inset.
const LAYOUT = stripComments(read('src/routes/+layout.svelte'));
const FIND = stripComments(read('src/routes/find/+page.svelte'));
const BAND = stripComments(read('src/lib/components/NowPlayingBand.svelte'));
// §4: the now-playing surface itself, plus the two vendored files `handleOnly` depends on. The drawer
// is where the hero's content went, so every arm that used to read the hero reads this instead; the
// `ui/drawer` pair is read because `handleOnly` is only load-bearing if a real vaul Handle exists for
// it to restrict dragging to.
const DRAWER = stripComments(read('src/lib/components/NowPlayingDrawer.svelte'));
const DRAWER_CONTENT = stripComments(read('src/lib/components/ui/drawer/drawer-content.svelte'));
const DRAWER_HANDLE = stripComments(read('src/lib/components/ui/drawer/drawer-handle.svelte'));

// ── the queue IS home, and nothing else is ───────────────────────────────────────────────────────
test('home renders NO now-playing surface — the layout owns the drawer, and the queue sheet stays gone', () => {
	/*
	 * REVERSED (header note §4). This arm required `<NowPlayingHero` ON THIS ROUTE, because direction A's
	 * answer to "where is the song I am singing" was a card at the top of the queue. The band made that
	 * card a duplicate and the hero is DELETED; the drawer in `routes/+layout.svelte` owns the job.
	 *
	 * REPLACED AT GREATER STRENGTH, not re-pointed. The old arm could make one claim ("the hero is
	 * here"). Three replace it, each falsifiable on its own, and together they say something the old one
	 * could not: that there is EXACTLY ONE now-playing surface in the app and it is reachable.
	 *
	 *   (a) the hero COMPONENT IS GONE from the tree, so it cannot be re-mounted by an import that
	 *       still resolves — a deletion is invisible to a suite where nothing imports the route.
	 *   (b) home mounts NO now-playing surface OF ANY KIND — not the hero, not the band, not the
	 *       drawer — so the route cannot grow a second one beside the layout's and disagree with it.
	 *   (c) the drawer is mounted EXACTLY ONCE, in the layout, permanently, with the band composed
	 *       INSIDE it as snap point 0. A drawer with no band in it is the same defect as no band, and it
	 *       is the defect the count alone would miss.
	 */
	// (a) gone from the tree, not merely unmounted.
	expect(existsSync(at('src/lib/components/NowPlayingHero.svelte'))).toBe(false);
	// (b) no now-playing surface on this route, in either direction — element or import.
	for (const surface of ['NowPlayingHero', 'NowPlayingBand', 'NowPlayingDrawer'])
		expect(PAGE, `home must not mount \`${surface}\`: the layout is the one owner`).not.toContain(surface);
	// (c) one drawer, in the layout, permanently mounted.
	expect(LAYOUT).toMatch(/import NowPlayingDrawer from '\$lib\/components\/NowPlayingDrawer\.svelte';/);
	expect((LAYOUT.match(/<NowPlayingDrawer\b/g) ?? []).length).toBe(1);
	/*
	 * RE-POINTED (§5), and what changed is the WIRING rather than the count. These three arms used to be
	 * `let drawerOpen = $state(false)`, `bind:open={drawerOpen}` and `onexpand={() => (drawerOpen =
	 * true)}` — the handshake between two surfaces. All three become BANS instead of moving to new
	 * names, because the merge IS their removal: the sheet never closes, so there is no open state, and
	 * the band is snap 0 of the sheet, so nothing raises it. Re-pointing them at some replacement name
	 * would pin a handshake the design deleted.
	 */
	expect(LAYOUT, 'a permanently-mounted sheet has no open state').not.toMatch(/\bdrawerOpen\b/);
	expect(LAYOUT, 'the band raises nothing now — it IS the sheet at snap 0').not.toContain('onexpand');
	expect(LAYOUT, 'the layout mounts the drawer; the drawer mounts the band').not.toContain('<NowPlayingBand');
	// …and the band really is in there, once, as the content's FIRST child, measuring itself into the
	// height that IS snap 0. Ordered against the header so "first child" is a claim and not a hope.
	expect((DRAWER.match(/<NowPlayingBand\b/g) ?? []).length).toBe(1);
	expect(DRAWER).toMatch(/<div class="band-slot"[^>]*bind:clientHeight=\{bandH\}>/);
	expect(DRAWER.indexOf('class="band-slot"')).toBeGreaterThan(-1);
	expect(DRAWER.indexOf('class="band-slot"')).toBeLessThan(DRAWER.indexOf('<Drawer.Header'));
	// The drag affordance inside that slot is vaul's own Handle — the element `handleOnly` restricts
	// dragging TO. This is what the band's click-only button could not be: a click cannot track a thumb.
	expect(DRAWER).toMatch(/<div class="band-slot"[\s\S]{0,200}?<Drawer\.Handle \/>/);
	/*
	 * RETIRED, WITH THE SOURCE FLAGGED. This arm required `{#if onexpand}` in `NowPlayingBand` — "the
	 * handle exists only when there is somewhere to pull to, and an affordance whose destination is
	 * absent is worse than no affordance". Nothing passes `onexpand` any more, so the band's gate is not
	 * WRONG, it is DEAD: the prop, its `{#if}` and its `.handle` button are unreachable from the app,
	 * and only /components still renders a band standalone. Asserting the gate's presence would pin dead
	 * code in place; asserting its absence would demand a source edit this guard is not the place to
	 * make. So it is recorded here and neither is asserted. NOTE for a source owner: `NowPlayingBand`'s
	 * `onexpand` prop and handle button, and `routes/+layout.svelte`'s now-unreferenced
	 * `import NowPlayingBand`, are all reachable only from /components. Flagged, not fixed.
	 */

	// The whole sheet rationale ("at a party you are either browsing or checking the queue, so the two
	// should not fight over one scroll") is what direction A INVERTS, so the sheet must not still be here
	// holding the rotation — and it must not come back on either surface that replaced the hero. Both
	// the import and the element, on all three.
	for (const [where, src] of [
		['routes/+page.svelte', PAGE],
		['routes/+layout.svelte', LAYOUT],
		['NowPlayingDrawer.svelte', DRAWER]
	] as const) {
		expect(src, `${where}: the retired queue sheet`).not.toContain('QueueSheet');
	}
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

test('the live singing controls live in the DRAWER, which IS the revealing, and home carries none (XR-PH-15)', () => {
	/*
	 * REVERSED (header note §4), and the reversal is the DISCLOSURE rather than the controls. This arm
	 * required guide / key / range to sit in a `controls()` snippet passed into the hero's Collapsible
	 * body, because the hero lived permanently on home and a permanent card cannot carry knobs. The
	 * drawer IS the act of revealing, so a disclosure inside it is a second tap to see what the first tap
	 * was for — and the nested "Vocal range" disclosure was a third.
	 *
	 * REPLACED AT GREATER STRENGTH. The old arm asserted the controls were SOMEWHERE inside one snippet,
	 * with a nesting-aware slice to keep that honest. Four claims replace it:
	 *
	 *   (1) all four controls are inside the drawer's `.tools-body`, sliced with the same nesting counter
	 *       so a nested block cannot make the arm report a false absence;
	 *   (2) that body is gated on a song playing NOW, so an idle room is not offered knobs with nothing
	 *       behind them — the hero's Collapsible could not claim this, since it rendered regardless;
	 *   (3) XR-PH-15's substance, which is what the disclosure was standing in for: the guiding-track
	 *       slider must not share a drag surface with the drawer's dismiss gesture. `handleOnly` on the
	 *       Root is the mechanism, AND the real vaul Handle it restricts dragging TO is pinned with it —
	 *       shadcn's copy-in shipped a decorative div, and `handleOnly` with no `data-vaul-handle` in the
	 *       tree makes the drawer silently undraggable, which fails worse than the defect it prevents;
	 *   (4) the range sits DIRECTLY BELOW the key row it answers about, with no disclosure of its own.
	 *
	 * …and (5) home carries NONE of it, so the controls cannot exist in two places at once and drift.
	 */
	// (1) THE SLICE COUNTS NESTING, for the reason the hero's snippet slice did: a slice that stops at
	// the first `</div>` is correct only while `.tools-body` has no nested block, which is a property of
	// today's markup rather than of the claim. S5's precedent is why this hardening is kept — a guard
	// that reports a false absence is worse than one that reports none.
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
	// The sheet was their only home, then the hero was. Deleting the hero without relocating them would
	// silently drop guide vocals, key and range from the phone — a user-facing regression no other test
	// would see, which is why each is named rather than counted.
	expect(toolsBody).toContain('<GuidingTrack');
	expect(toolsBody).toContain('<RangeBar');
	expect(toolsBody).toContain('class="key"');
	expect(toolsBody).toContain('<LyricsReselect');
	// The guide's reason-before-the-dead-row note (XR-PH-03) came with them.
	expect(toolsBody).toContain('class="tools-note"');

	// (2) gated on a song playing NOW — the transport survives an idle room, the knobs do not.
	const hasSongGate = DRAWER.indexOf('{#if hasSong}');
	expect(hasSongGate).toBeGreaterThan(-1);
	expect(hasSongGate).toBeLessThan(DRAWER.indexOf('<div class="tools-body">'));
	// …and the transport is OUTSIDE that gate, in the drawer's own body, with all three controls.
	expect(toolsBody).not.toContain('class="transport"');
	expect(DRAWER.indexOf('class="np-body"')).toBeLessThan(DRAWER.indexOf('<div class="transport">'));
	/*
	 * THREE controls in the row: Restart · Play/Pause · Skip (ratified 2026-09-18). The row was two for a
	 * while, with play/pause only on the band's disc, because two play buttons on one open surface had been
	 * reported as duplicates — and the cost was a transport split between the top-right of the band row and
	 * the bottom-left of the body, in two different shapes. The ruling went the other way: a whole
	 * prev·play·next transport, and the disc stays for the collapsed height.
	 *
	 * THE PLAY/PAUSE IS MATCHED AS AN EXPRESSION, not as a literal `aria-label="…"`, because that is how it
	 * names itself — and because the arm this replaces asserted the absence of `aria-label="play/pause"`, the
	 * DELETED button's literal label, which would have gone on passing with the restored button in place. An
	 * assertion that cannot fail for the thing it is about is worse than no assertion.
	 */
	for (const label of ['Restart', 'skip'])
		expect(DRAWER, `the transport lost its \`${label}\` control`).toContain(`aria-label="${label}"`);
	expect(DRAWER, 'the transport row lost its play/pause').toMatch(/aria-label=\{isPlaying \? 'Pause' : 'Play'\}/);
	expect(DRAWER, 'and the play/pause must sit BETWEEN restart and skip, not beside them').toMatch(
		/aria-label="Restart"[\s\S]*aria-label=\{isPlaying \? 'Pause' : 'Play'\}[\s\S]*aria-label="skip"/
	);
	// Centred, which is the half of "one transport" that CSS owns — left-aligned it reads as loose buttons.
	expect(DRAWER, 'the transport row must be centred').toMatch(/\.transport\s*\{[^}]*justify-content:\s*center/);
	expect(DRAWER, 'and the band it composes carries the one that survives a collapse').toContain('<NowPlayingBand');

	// (3) XR-PH-15, at the address the drawer answers it: dragging restricted to the handle…
	expect(DRAWER).toMatch(/<Drawer\.Root\b[^>]*\bhandleOnly\b/);
	// …and a REAL handle for it to be restricted to. Without these two the prop is a silent no-op that
	// makes the drawer undraggable, so asserting `handleOnly` alone would be asserting nothing.
	//
	// THE HANDLE MOVED, AND THE CLAIM FOLLOWED IT. This used to require `<DrawerHandle>` inside the
	// VENDORED `drawer-content.svelte`, which rendered one at the top of the content box. Composing the
	// band into the sheet put a second handle in `.band-slot`, so two grab bars were drawn one above the
	// other — reported on sight. The vendored one is gone; the one in the band row is the real one,
	// because that is where a thumb reaches it. What matters is unchanged: exactly ONE element carrying
	// vaul's `data-vaul-handle` exists for `handleOnly` to restrict dragging to. So this asserts the
	// handle at its NEW address, and asserts the vendored file no longer renders a competing one.
	expect(DRAWER).toMatch(/<Drawer\.Handle\b/);
	expect(DRAWER_CONTENT).not.toMatch(/<DrawerHandle\b/);
	expect(DRAWER_HANDLE).toMatch(/<DrawerPrimitive\.Handle\b/);
	// No second disclosure anywhere on this surface: the drawer is the one level of revealing.
	expect(DRAWER).not.toContain('Collapsible');

	// (4) the range is directly below the key row, in DOM order, inside the same body.
	expect(toolsBody.indexOf('class="key"')).toBeLessThan(toolsBody.indexOf('<div class="range">'));

	// (5) home carries none of it. Without this the controls could come back in two places at once —
	// two surfaces reading the same room and writing the same commands, disagreeing under a slow socket.
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
	 * RE-POINTED, AND THE OWNERSHIP IS WHAT MOVED (header note §1, then §5). XR-PH-12 itself is
	 * untouched: the band's height is MEASURED and reserved in normal flow, never guessed at with a
	 * constant. What changed is who measures and who reserves. `.search-dock` in this route used to do
	 * both; then a `.dock` wrapper in `routes/+layout.svelte` bound the band's clientHeight; now the band
	 * is snap 0 of the drawer, so `.band-slot` measures ITSELF inside `NowPlayingDrawer` and the layout
	 * takes that number back through `bind:bandH={dockH}` to stay the single publisher. Two steps, one
	 * measurement, TWO consumers reserving it — asserted at every end, plus the negative: this route must
	 * NOT publish the token, because two writers of an inline `:root` property fight silently.
	 */
	// The measured height — taken off the rendered band row, then published by the LAYOUT.
	expect(DRAWER).toMatch(/<div class="band-slot"[^>]*bind:clientHeight=\{bandH\}>/);
	expect(LAYOUT).toMatch(/bind:bandH=\{dockH\}/);
	expect(LAYOUT).toMatch(/setProperty\(\s*'--dock-h'/);
	// MEASURED, not a constant, and this is where that word is falsifiable: the published value
	// interpolates the bound state rather than naming a height.
	expect(LAYOUT).toMatch(/setProperty\('--dock-h', `\$\{dockH\}px`\)/);
	expect(PAGE).not.toContain('bind:clientHeight');
	expect(PAGE).not.toContain('bind:bandH');
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
	// RE-POINTED (§5): the thing mounted after the children is the drawer, which contains the band.
	expect(LAYOUT.indexOf('<NowPlayingDrawer')).toBeGreaterThan(LAYOUT.indexOf('{@render children()}'));
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
	// Docked, gated on a joined singer — and it is ONE component now (§5): the drawer, with the band
	// composed inside it as snap point 0. `bind:bandH={dockH}` is the hop that carries the band's real
	// rendered height back to the layout, which is still the only writer of --dock-h. Written with a
	// bounded window rather than `[^>]*` because the tag's own props contain `>` (`() => goto(…)`), so a
	// negated-class run would stop at the first arrow rather than at the end of the tag.
	expect(LAYOUT).toMatch(/\{#if showBand\}\s*<NowPlayingDrawer\b[\s\S]{0,200}?bind:bandH=\{dockH\}/);
	/*
	 * RETIRED (§5) — two positive arms, recorded here because the mechanism is GONE rather than moved:
	 *
	 *     expect(LAYOUT).toMatch(/class:covered=\{drawerOpen\}/);
	 *     expect(LAYOUT).toMatch(/\.dock\.covered \{\s*opacity: 0;/);
	 *
	 * They pinned the fade that took the band out from under the opening drawer. It was real: both
	 * surfaces were `--card` with a 1px top border and a 12px top radius, so a sheet rising over the band
	 * showed two matching top edges at once and read as a second copy of the same panel arriving rather
	 * than as the panel growing. With one surface at two heights there is no second edge, nothing to
	 * step out from under, and no state to drive a fade from.
	 *
	 * DELETED AS VACUOUS, not left green — the rider that travelled with them:
	 *
	 *     expect(LAYOUT).not.toMatch(/\.dock\.covered \{[^}]*visibility/s);
	 *
	 * WHAT IT PROTECTED: the fade had to be `opacity` and never `visibility` or a height change. The band
	 * stayed in the layout while the drawer was open, so --dock-h must not move or every scrolling column
	 * reflows behind it; and `visibility: hidden` would have cut the cross-fade to a pop.
	 * WHY IT IS DELETED RATHER THAN RE-POINTED: there is no `.dock.covered` rule left for the negative to
	 * examine, so it passes while looking at nothing — enforcement in appearance only. And the rule has no
	 * successor to re-point it at: no fade means no property to insist on, so nothing can regress into
	 * `visibility`. The bans below carry what is left of the claim, which is that the two-surface
	 * arrangement itself must not come back.
	 */
	expect(LAYOUT, 'the retired fade: no class, no rule, no state named `covered`').not.toContain('covered');
	expect(LAYOUT, 'the retired positioning wrapper — vaul fixes the drawer content itself').not.toContain(
		'class="dock"'
	);
	// The band is mounted by the DRAWER now, which is the only place it can be and still be snap 0.
	expect(DRAWER).toContain('<NowPlayingBand');
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

	/*
	 * EXACTLY ONE, RE-EXPRESSED AGAINST THE NEW IDIOM (§5) rather than deleted — the COUNT is the point of
	 * this arm. Two bands both binding `dockH` was the shape BEFORE the owner correction (`.cta-dock` on
	 * home, `.search-dock` on browse); collapsing to one survived the band phase and it survives the
	 * merge. The single binding is now a two-step publish, so both steps are counted: one MEASUREMENT
	 * (`bind:clientHeight={bandH}` on `.band-slot`, inside the drawer, which is also snap 0) and one HOP
	 * (`bind:bandH={dockH}`, in the layout). A second of either forks the geometry the measurement exists
	 * to keep single.
	 */
	const measured = DRAWER.match(/bind:clientHeight=\{bandH\}/g) ?? [];
	expect(measured.length).toBe(1);
	const hops = [LAYOUT, PAGE, FIND].join('\n').match(/bind:bandH=\{dockH\}/g) ?? [];
	expect(hops.length).toBe(1);
	// …and no phone surface measures a band of its own. WIDENED from the old `={dockH}` form: any
	// clientHeight binding on one of these three is a second measurement competing with the band's.
	for (const [where, src] of [
		['routes/+layout.svelte', LAYOUT],
		['routes/+page.svelte', PAGE],
		['routes/find/+page.svelte', FIND]
	] as const)
		expect(src, `${where} must not measure a second docked band`).not.toContain('bind:clientHeight');
	/*
	 * THE ONE-env() RULE, unchanged in substance and re-pointed at the element that now sits between the
	 * band and the bottom edge. The inset lives on the BAND's own padding and reaches everything stacked
	 * above it THROUGH --dock-h, which is bound to `.band-slot`'s clientHeight and so includes it. A
	 * second env() term ON OR INSIDE that measured element doubles the gap on a notched phone. So: one on
	 * the band, none on `.band-slot` (height and clipping only), none on either column's reserve, and none
	 * at all in the layout — which declares no CSS whatsoever now.
	 */
	const bandCss = BAND.slice(BAND.indexOf('.band {'), BAND.indexOf('.inner {'));
	expect((bandCss.match(/env\(safe-area-inset-bottom/g) ?? []).length).toBe(1);
	// Non-vacuity on the slices below: an unmatchable selector slices to nothing, and a `not.toContain`
	// over nothing passes while examining nothing.
	expect(DRAWER.indexOf('.band-slot {'), '.band-slot must still be the measured band row').toBeGreaterThan(-1);
	const slotCss = DRAWER.slice(DRAWER.indexOf('.band-slot {'), DRAWER.indexOf('.band-slot :global(.band)'));
	expect(slotCss.length).toBeGreaterThan(0);
	expect(slotCss).not.toContain('env(safe-area-inset-bottom');
	/*
	 * The drawer CONTENT does carry an inset of its own, and it is not a second term in this stack: it is
	 * an ANCESTOR of `.band-slot`, so its padding is outside the measured clientHeight, and it is the
	 * bottom-most element only while the sheet is pulled up — which is exactly when the band is not.
	 * Counted rather than named, so a THIRD env() cannot appear in this file unnoticed.
	 */
	expect((DRAWER.match(/env\(safe-area-inset-bottom/g) ?? []).length).toBe(1);
	expect(LAYOUT, 'the layout declares no CSS at all now — vaul positions the content').not.toContain(
		'env(safe-area-inset-bottom'
	);
	for (const [where, src] of [
		['routes/+page.svelte', PAGE],
		['routes/find/+page.svelte', FIND]
	] as const) {
		const mainCss = src.slice(src.indexOf('\tmain {'), src.indexOf('\tmain {') + 200);
		expect(mainCss, `${where} must still declare a top-level main rule`).toContain('padding:');
		expect(mainCss, `${where}'s reserve must not add a second env() term`).not.toContain('env(safe-area-inset-bottom');
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
	expect(PAGE).toMatch(/import MyPositionCard from '\$lib\/components\/MyPositionCard\.svelte';/);
	/*
	 * RE-POINTED (header note §4). The now-playing surface is the LAYOUT's, so the import this arm used
	 * to pin here — `NowPlayingHero` — is pinned there instead, as the component the layout mounts. Same
	 * claim at the same strength, one address up: the layout has no unit harness either (it imports
	 * `$app/state` and `$app/navigation`, neither of which the test harness aliases), so a dropped import
	 * reds `build`/`typecheck` and leaves the suite green exactly as it did on the route.
	 *
	 * …and RE-POINTED ONE ADDRESS FURTHER for the band (§5). Its import used to be pinned here because the
	 * layout mounted it; the DRAWER composes it now, so the drawer is where dropping it is a build break.
	 * The layout's own `import NowPlayingBand` still exists and is UNREFERENCED — a leftover of the merge —
	 * so this arm deliberately asserts neither its presence (which would pin dead code in place) nor its
	 * absence (which would demand a source edit from a guard). Flagged for a source owner, not fixed.
	 */
	expect(LAYOUT).toMatch(/import NowPlayingDrawer from '\$lib\/components\/NowPlayingDrawer\.svelte';/);
	expect(DRAWER).toMatch(/import NowPlayingBand from '\$lib\/components\/NowPlayingBand\.svelte';/);
	// songDisplay is what keeps the song's title and artist APART — `mediaTitle` welds them together,
	// and the cards' own history is that the uploader ended up rendered as the artist. RE-POINTED with
	// the mirror it serves: the layout is the one place that reads the room for the band and the drawer,
	// so it is the one place that calls songDisplay. Asserted against the IMPORT LIST, not the file: the
	// call site mentions the name too, so a file-wide scan would stay green with the import removed and
	// prove nothing about the hunk that adds it.
	const shared = LAYOUT.slice(LAYOUT.indexOf('import {'), LAYOUT.indexOf("} from '$lib/contract';"));
	expect(shared).toMatch(/(^|[\s,])songDisplay\s*(,|$)/m);
	// …and the byline keeps the uploader fallback the browse row uses for a READY song, or the drawer and
	// the band both silently show no artist for every song whose parse was not confident — which is most
	// local files.
	expect(LAYOUT).toMatch(/display\.artist \?\? media\?\.artist \?\? null/);
});

// ── the transport's CSS went with the buttons ────────────────────────────────────────────────────
test('the route no longer declares the transport styles the drawer now owns', () => {
	// A PURE DELETION, so reverting it re-adds rules nothing selects and the suite stays green — the
	// exit-20 case §3 names, closed by scanning the real production file. Two arms, because the finding
	// is not only "unused": the block held four of this route's `44px` literals, and XR-PH-01's whole
	// point is that a literal is invisible to the standard it is meant to express.
	expect(PAGE).not.toMatch(/^\s*\.ic\s*\{/m);
	expect(PAGE).not.toMatch(/^\s*\.ic\.play\s*\{/m);
	expect(PAGE).not.toMatch(/^\s*\.ic:disabled\s*\{/m);
	// …and no markup left behind that would have needed them, nor a second copy of the rule the
	// transport's new home declares.
	expect(PAGE).not.toContain('class="ic ');
	expect(PAGE).not.toContain('no-drag');
	expect(PAGE).not.toMatch(/^\s*\.transport\s*\{/m);
	/*
	 * RE-POINTED (header note §4): the DRAWER owns them now, not the hero. Same two claims at the same
	 * strength — the transport really renders where the rules went, and it is sized from the token rather
	 * than the number — read off the real production file so a pure deletion cannot pass unnoticed.
	 */
	const DRAWER_SRC = read('src/lib/components/NowPlayingDrawer.svelte');
	/*
	 * The transport the route no longer owns is Restart + Skip now; the sheet's play/pause was deleted when
	 * the band's disc became the app's only one. Asserting the deleted label here would pin the duplicate.
	 */
	expect(DRAWER_SRC).toContain('aria-label="Restart"');
	expect(DRAWER_SRC).toContain('aria-label="skip"');
	/*
	 * RE-POINTED AT THE COMMENT-STRIPPED SOURCE (§5), and this one is a false positive rather than a moved
	 * claim. `44px` is an assertion about a DECLARATION — a control sized by the number instead of by
	 * `--tap`, which is XR-PH-01's whole point. The drawer's snap-point rationale now records its measured
	 * symptoms in an "844px viewport", which CONTAINS that substring, so a raw scan reds on prose
	 * documenting vaul's translate arithmetic. `DRAWER` is the same production file with its comments
	 * blanked, which is the only text where a literal-versus-token claim can be about code.
	 */
	expect(DRAWER).not.toContain('44px');
	// Non-vacuity: the transport really is in the stripped text, so the negative examines the file that
	// declares it rather than an empty string.
	expect(DRAWER).toContain('class="transport"');
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
