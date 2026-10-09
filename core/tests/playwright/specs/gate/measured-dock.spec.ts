/*
 * CLAIM 3: THE DOCK — one fixed container holding two stacked rows, the now-playing strip and the tab bar —
 * publishes its REAL measured height as --dock-h, composes the home-indicator inset exactly once, is reserved
 * by every scrolling column, and has NO OPEN STATE. Measured across both strip states, both insets, and five
 * surfaces.
 *
 * ONE TEST, because four of its arms are CROSS-STATE and no single-state reading can see any of them:
 *   · the published height must TRACK the strip appearing and then disappearing again;
 *   · present minus absent must EQUAL the strip's own rendered height;
 *   · the token must be the same on every surface, which is a comparison between surfaces;
 *   · at least one driven column must really have scrolled and at least one must not, which is the old spec's
 *     "short case" asserted on real screens instead of synthesised from a non-matching query.
 * Every arm is soft, so one run reports every broken arm rather than the first.
 *
 * THE 1px TOLERANCES ARE ROUNDING, NOT SLACK. `clientHeight` is an integer and a rect height is sub-pixel, so
 * the two legitimately differ by a fraction. The defects these arms catch are wrong by tens of pixels (a
 * missing or doubled safe-area term) or by a whole state (a strip that renders when nothing is playing).
 *
 * WHAT THIS REPLACED, and why the replacement is stronger rather than looser. The version before this one had
 * already been retargeted off the deleted band onto `.dock`, so it ran and it passed — and that was the problem.
 * FOUR THINGS IT COULD NOT SEE. It queued a song FIRST and measured only states on the far side of that branch,
 * so the strip's two states, the round trip between them, and the height the dock gives back were all invisible.
 * It read the reservation off `main` alone, which is simply wrong on /stats — the declaration is on the section
 * there and `main` reserves 0px. It drove ONE surface. And it made no claim at all about the strip having no open
 * state, which is the thing the owner actually reported. Only its "short case" is weaker here on paper: it forced
 * a `zzzzznotasongzzzzz` query, and its own comment recorded that query having silently skipped three arms on a
 * networked host because the default search source fuzzy-matches. The replacement is `/queue` and `/library`,
 * which genuinely cannot scroll on this fixture (measured maxScroll 0 on each), beside /settings and /stats,
 * whose columns are static content and so scroll whatever the network answered (measured maxScroll 1267 and 275) —
 * and the drive PROVES it reached both classes rather than assuming it.
 *
 * ALL NUMBERS IN THIS FILE ARE ASSERTED RELATIONALLY. 46 and 91 appear only in comments, as measurements with
 * the viewport named, never as thresholds — so a --tap bump or a label reflow moves the measurement instead of
 * reddening the gate. Same split the register already makes between TAP and TAP_FLOOR.
 */
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { FLOORS, SIMULATED_BOTTOM_INSET } from './measured-design-register';
import { fill, openBrowse, setSafeAreaInsets } from './measured-design-support';
import type { Page } from '@playwright/test';

/*
 * THE SHEET'S OWN MARKUP, spelled HERE and deliberately not as keys in selectors.ts. Every value below is in
 * that file's RETIRED block, banned BY VALUE, precisely because a revived key would resolve against something
 * else: `.band` and `.band-slot` are gone, but `.strip` on its own matches the TV lobby's roster. A ban list
 * needs the strings, and the one legitimate use of a banned string is the arm that proves it matches nothing.
 */
const SHEET_MACHINERY = [
	'[data-vaul-drawer]',
	'[data-vaul-drawer-wrapper]',
	'[data-slot="drawer-content"]',
	'[data-slot="drawer-handle"]',
	'.np-drawer',
	'.band-slot',
	'.band'
].join(', ');

/**
 * What an EXPANDABLE thing looks like from the outside, whoever built it. `aria-expanded` and `data-state` are
 * how both vaul and bits-ui published a sheet's open/closed state, `role="dialog"` is what an expanded sheet
 * became, and `draggable="true"` is the native handle. The strip's contract is that none of the four exists
 * inside the dock at all — not that they are all currently "closed".
 */
const EXPAND_AFFORDANCES = '[aria-expanded], [data-state], [role="dialog"], [draggable="true"]';

interface DockReading {
	/** Named so a firing non-vacuity floor can list the states the drive did reach. */
	state: string;
	path: string;
	insetBottom: number;
	dockVar: string;
	dockInline: string;
	dockClientHeight: number;
	dockRectHeight: number;
	dockTop: number;
	dockBottom: number;
	dockPadBottom: number;
	dockTransform: string;
	stripPresent: boolean;
	stripLabel: string | null;
	stripHeight: number | null;
	stripPadBottom: number | null;
	stripsInDock: number;
	stripsOutsideDock: number;
	transportButtons: number;
	/** Is the play control actually tappable? A bright-but-dead primary is the defect this file exists to catch. */
	playEnabled: boolean | null;
	tabsHeight: number;
	tabsPadBottom: number;
	/** Max computed padding-bottom on the chain `main` → `.app-shell`, inclusive. See the note on the walk. */
	reserve: number;
	/** The chain itself, element by element, so a failing reserve names which box was supposed to carry it. */
	reserveChain: string[];
	leaves: number;
	occluded: number;
	occludedNames: string[];
	sheetMachinery: number;
	expandAffordances: number;
	innerHeight: number;
	scrollY: number;
	maxScroll: number;
}

/**
 * ONE PROBE, one `page.evaluate`, every reading this claim takes. Returns null only when `.dock` is missing,
 * which is then a named soft failure rather than a crash: the root layout mounts the dock for any joined
 * singer on any phone surface, so its absence is either an unjoined drive or the container itself.
 */
async function readDock(page: Page, state: string, insetBottom: number): Promise<DockReading | null> {
	return page.evaluate(
		({ arg, dockSel, stripSel, tabsSel, shellSel, sheetSel, expandSel, bareStrip, transportSel }) => {
			const dock = document.querySelector(dockSel);
			if (!dock) return null;
			const dr = dock.getBoundingClientRect();
			const strip = document.querySelector(stripSel);
			const tabs = document.querySelector(tabsSel);
			const shell = document.querySelector(shellSel);
			const padBottom = (el: Element) => parseFloat(getComputedStyle(el).paddingBottom) || 0;

			/* THE RESERVE WALK, and it is generic because a `main`-only reading is WRONG on a real surface.
			   `SEL.mainColumn` is `main`, and on /stats the reservation is declared on the `.stats` SECTION that
			   wraps the header and the column together, while `main` itself reserves nothing — measured 139px on
			   `section.stats` against 0px on its own `main`. A `main`-only arm therefore reports a broken contract
			   on a correct tree the moment /stats is driven. Walking up to `.app-shell` and taking the max is the
			   smallest reading that is right on all five surfaces and needs no per-route table. */
			let reserve = 0;
			const reserveChain: string[] = [];
			let node: Element | null = shell ? shell.querySelector('main') : null;
			while (node) {
				const pb = padBottom(node);
				const cls = String(node.className || '')
					.replace(/svelte-[\w-]+/g, '')
					.trim()
					.split(/\s+/)
					.filter(Boolean)
					.join('.');
				reserveChain.push(`${node.tagName.toLowerCase()}${cls ? `.${cls}` : ''} pb=${pb}px`);
				if (pb > reserve) reserve = pb;
				if (node === shell) break;
				node = node.parentElement;
			}

			/* THE LEAF OCCLUSION SWEEP — "no content sits under the dock", read geometrically rather than from
			   anyone's padding, so it needs no per-route knowledge and works on /stats too.

			   LEAVES, NOT CONTAINERS, and that is forced: a padded container's own box legitimately extends behind
			   the dock, because that padding IS the reservation. MEASURED at max scroll with the leaf filter
			   removed: /settings sweeps 120 boxes and HITS TWO — `div.settings-page` and `main`, which are the two
			   boxes carrying the reservation — and /stats sweeps 46 and hits `section.stats`, which is exactly
			   where /stats declares it. So a container sweep reports the reservation as the defect it is there to
			   prove. Leaves are what a guest reads and tries to touch, which is what the claim is about.

			   A FIXED OR STICKY ANCESTOR IS EXCLUDED TOO, not just a fixed leaf: a toast is `position: fixed` and
			   offsets --dock-h itself, so its text is not the scrolling column and a toast in flight would red a
			   correct tree. Measured 0 hits at max scroll on all five surfaces either way, so this scopes the arm
			   rather than weakening a reading. */
			let leaves = 0;
			let occluded = 0;
			const occludedNames: string[] = [];
			const detached = (el: Element) => {
				for (let n: Element | null = el; n && n !== shell; n = n.parentElement) {
					const p = getComputedStyle(n).position;
					if (p === 'fixed' || p === 'sticky') return true;
				}
				return false;
			};
			if (shell) {
				for (const el of shell.querySelectorAll('*')) {
					if (el.childElementCount !== 0) continue;
					const cs = getComputedStyle(el);
					if (cs.display === 'none' || cs.visibility === 'hidden') continue;
					const r = el.getBoundingClientRect();
					if (r.width <= 0.5 || r.height <= 0.5) continue;
					if (detached(el)) continue;
					leaves++;
					if (r.bottom > dr.top + 1 && r.top < dr.bottom - 1) {
						occluded++;
						if (occludedNames.length < 6) {
							const cls = String(el.className || '')
								.replace(/svelte-[\w-]+/g, '')
								.trim()
								.split(/\s+/)
								.filter(Boolean)
								.slice(0, 2)
								.join('.');
							occludedNames.push(`${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`);
						}
					}
				}
			}

			return {
				...arg,
				path: location.pathname,
				dockVar: getComputedStyle(document.documentElement).getPropertyValue('--dock-h').trim(),
				dockInline: document.documentElement.style.getPropertyValue('--dock-h').trim(),
				dockClientHeight: dock.clientHeight,
				dockRectHeight: dr.height,
				dockTop: dr.top,
				dockBottom: dr.bottom,
				dockPadBottom: padBottom(dock),
				// A reintroduced translateY-based drag is what this catches, which is why it is read and not derived.
				dockTransform: getComputedStyle(dock).transform,
				stripPresent: !!strip,
				stripLabel: strip ? strip.getAttribute('aria-label') : null,
				stripHeight: strip ? strip.getBoundingClientRect().height : null,
				stripPadBottom: strip ? padBottom(strip) : null,
				stripsInDock: dock.querySelectorAll(bareStrip).length,
				stripsOutsideDock: [...document.querySelectorAll(bareStrip)].filter((e) => !dock.contains(e)).length,
				playEnabled: (() => {
					const play = dock.querySelector('.strip .tp .btn.primary');
					return play ? !(play as HTMLButtonElement).disabled : null;
				})(),
				// THROUGH THE REGISTRY, `SEL.npTransport`. It is already `.dock`-scoped by value, so it is the one
				// reading here that needs none of the `dock.querySelectorAll` scoping the bare `.strip` above does.
				transportButtons: document.querySelectorAll(transportSel).length,
				tabsHeight: tabs ? tabs.getBoundingClientRect().height : Number.NaN,
				tabsPadBottom: tabs ? padBottom(tabs) : Number.NaN,
				reserve,
				reserveChain,
				leaves,
				occluded,
				occludedNames,
				sheetMachinery: document.querySelectorAll(sheetSel).length,
				expandAffordances: dock.querySelectorAll(expandSel).length,
				innerHeight: window.innerHeight,
				scrollY: Math.round(window.scrollY),
				maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight)
			};
		},
		{
			arg: { state, insetBottom },
			dockSel: SEL.dock,
			stripSel: SEL.npStrip,
			tabsSel: SEL.tabBar,
			shellSel: SEL.appShell,
			sheetSel: SHEET_MACHINERY,
			expandSel: EXPAND_AFFORDANCES,
			transportSel: SEL.npTransport,
			// A BARE `.strip`, scoped in the query below rather than in the value, because this is the arm that
			// counts strips INSIDE the dock against strips OUTSIDE it. `SEL.npStrip` is already dock-scoped, so it
			// cannot express "and none anywhere else".
			bareStrip: '.strip'
		}
	);
}

/** Scroll to the bottom and let the paint settle. There is no smooth scrolling in this app, so 400ms is settle
 *  rather than animation. */
async function toEnd(page: Page): Promise<void> {
	await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
	await page.waitForTimeout(400);
}

test('CLAIM 3 the dock publishes its measured height, spells the safe-area inset once, is reserved on every surface, and has no open state', async ({
	world
}) => {
	const readings: DockReading[] = [];
	/** Every read goes through here, so the non-vacuity floor counts what was really taken. */
	const take = async (page: Page, state: string, inset = 0): Promise<DockReading | null> => {
		const r = await readDock(page, state, inset);
		expect
			.soft(
				r,
				`CLAIM 3 the dock is mounted in state "${state}", so its contract is measurable: no ${SEL.dock} found on ` +
					`${page.url()} — the root layout mounts the dock for any joined singer on any phone surface, so its ` +
					'absence is either an unjoined drive or the container itself'
			)
			.not.toBeNull();
		if (r) readings.push(r);
		return r;
	};

	const page = await world.openPhone(`Dock${Date.now() % 1_000_000}`);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	await page.locator(SEL.dock).first().waitFor({ state: 'attached', timeout: 15_000 });
	// A DWELL, not a missing auto-wait: --dock-h is the layout's own measurement of a container that has just
	// mounted, so this lets the measured write land before anything reads it back.
	await page.waitForTimeout(900);

	/* ── STATE A — AT REST, AND THE STRIP IS ABSENT ──────────────────────────────────────────────────────────
	   A virgin room has nothing playing and nothing queued, so the strip does not render and the tab bar alone
	   holds the bottom. That is the state the gate's own fixture lands a joined phone in, and no earlier version of
	   this file ever read it: the band it replaced was permanently present, and the version after that queued a
	   song before it measured anything. Measured at 390x844: --dock-h 46px, dock 46 clientHeight / 46.00 rect, no
	   strip, tab bar 46px, main reserving 74px. */
	const atRest = await take(page, 'A / at rest, strip absent');
	if (atRest) {
		expect
			.soft(
				atRest.stripPresent,
				'CLAIM 3 an IDLE room shows NO transport — the strip renders only when there is something to act on: ' +
					`a ${SEL.npStrip} is present on a freshly joined room with nothing playing and nothing queued, which is the ` +
					"design review's dead play button back again"
			)
			.toBe(false);
		// THE PAIR IS EXACT, and it is the half that says the value was WRITTEN by the layout's measurement rather
		// than inherited from a stylesheet: an inline custom property on :root is what `bind:clientHeight` sets.
		expect
			.soft(
				atRest.dockVar !== '' && atRest.dockVar === atRest.dockInline,
				'CLAIM 3 --dock-h is PUBLISHED by the layout, as one inline custom property on :root: ' +
					`--dock-h resolved "${atRest.dockVar}" against an inline value of "${atRest.dockInline}" ` +
					'(an empty inline value means nothing measured it; a disagreement means a stylesheet is answering instead)'
			)
			.toBe(true);
		expect
			.soft(
				Math.abs(parseFloat(atRest.dockVar) - atRest.dockRectHeight) <= 1 &&
					Math.abs(parseFloat(atRest.dockVar) - atRest.dockClientHeight) <= 1,
				"CLAIM 3 the published height IS the dock's RENDERED height — the contract every scrolling column offsets " +
					`from: --dock-h "${atRest.dockVar}" against a rect of ${atRest.dockRectHeight.toFixed(2)}px and a clientHeight ` +
					`of ${atRest.dockClientHeight}px. The dock declares no border and no padding, so the three are one number ` +
					'and the 1px allowance is only clientHeight rounding'
			)
			.toBe(true);
		expect
			.soft(
				Math.abs(atRest.dockRectHeight - atRest.tabsHeight) <= 1,
				'CLAIM 3 with no strip the dock IS the tab bar — no reservation is kept for a row that does not render: ' +
					`dock ${atRest.dockRectHeight.toFixed(2)}px against a tab bar of ${atRest.tabsHeight.toFixed(2)}px`
			)
			.toBe(true);
	}

	/* ── STATE B — THE SAFE-AREA TERM, SPELLED EXACTLY ONCE ───────────────────────────────────────────────────
	   HEADLESS HAS NO NOTCH: every `env(safe-area-inset-*)` resolves to 0, so a composed term and a bare value
	   measure identically and an arm comparing them proves nothing. `setSafeAreaInsets` makes the wire call; the
	   note on it in measured-design-support covers why it is CDP and not a Playwright API.

	   THIS ARM IS TWO-SIDED, which is the point of the one-fixed-container arrangement. The tab bar is the DOCK's
	   bottom-most row and the dock's SOLE declarer — not the app's: `.app-shell` spends the same inset on the
	   scrolling column (measured padding-bottom 0→34px there too) and the dock is NOT inside it, so the two terms
	   cannot compound. A MISSING term reads as a dock delta of 0 and a DOUBLED one as 68. Measured at 390x844,
	   strip absent: dock 46→80px, tab bar padding-bottom 0→34px, the dock's own padding-bottom 0px at both
	   insets. */
	await setSafeAreaInsets(page, { bottom: SIMULATED_BOTTOM_INSET });
	// A DWELL: the override is a compositor-side change, so the cascade re-resolves and repaints before the
	// padding can be read back.
	await page.waitForTimeout(800);
	const inset = await take(page, 'B / at rest, simulated bottom inset', SIMULATED_BOTTOM_INSET);
	if (atRest && inset) {
		expect
			.soft(
				Math.abs(inset.tabsPadBottom - (atRest.tabsPadBottom + SIMULATED_BOTTOM_INSET)) < 1,
				`CLAIM 3 the TAB BAR composes env(safe-area-inset-bottom) — the home indicator never sits on a tab: ` +
					`tab bar padding-bottom ${atRest.tabsPadBottom}px at inset 0 against ${inset.tabsPadBottom}px at a simulated ` +
					`${SIMULATED_BOTTOM_INSET}px inset`
			)
			.toBe(true);
		expect
			.soft(
				Math.abs(inset.dockRectHeight - (atRest.dockRectHeight + SIMULATED_BOTTOM_INSET)) < 1 &&
					Math.abs(parseFloat(inset.dockVar) - (parseFloat(atRest.dockVar) + SIMULATED_BOTTOM_INSET)) < 1,
				'CLAIM 3 the inset reaches the PUBLISHED height too, and exactly once — a missing term reads as a delta of ' +
					`0 and a doubled one as ${SIMULATED_BOTTOM_INSET * 2}: the dock went ${atRest.dockRectHeight.toFixed(2)}px → ` +
					`${inset.dockRectHeight.toFixed(2)}px and --dock-h "${atRest.dockVar}" → "${inset.dockVar}" under a simulated ` +
					`${SIMULATED_BOTTOM_INSET}px inset`
			)
			.toBe(true);
		expect
			.soft(
				inset.dockPadBottom,
				'CLAIM 3 the CONTAINER composes no inset of its own — it is declared on the tab bar inside it and nowhere ' +
					`else: the dock's own padding-bottom is ${inset.dockPadBottom}px under a simulated ${SIMULATED_BOTTOM_INSET}px inset`
			)
			.toBe(0);
	}
	await setSafeAreaInsets(page, { top: 0, right: 0, bottom: 0, left: 0 });
	await page.waitForTimeout(500);

	/* ── STATE C — DRIVE THE STRIP UP ─────────────────────────────────────────────────────────────────────────
	   Through the real find column, because that is the only path a guest has.

	   THE SOURCE IS NARROWED TO `local`: the default `music` source fans out to YouTube Music, so the first row
	   would be a remote result whose action starts a fetch job, and the result content would not be this
	   fixture's to own. The ACTION is `addOrSing`, the UNION, because the seeded demo WAVs have no stems — their
	   row offers process-and-queue, so `[data-testid="song-add"]` alone resolves against nothing here. */
	const track = await world.awaitDemoTrack();
	await openBrowse(page);
	await page.locator(SEL.searchSource).first().selectOption('local');
	await fill(page, SEL.search, track.title);
	await page.locator(SEL.songRow).first().waitFor({ state: 'attached', timeout: 20_000 });
	await page.waitForTimeout(600);

	// A SEARCH ALONE MUST NOT CONJURE A TRANSPORT. Measured at 390x844: the scanner titles the seeded fixture
	// `sweet-caroline`, so narrowed to `local` that query returns exactly ONE row — offering `song-sing`, because
	// the WAV has no stems — and --dock-h is still 46px with no strip.
	const searched = await take(page, 'C / with results, nothing queued yet');
	if (searched) {
		expect
			.soft(
				searched.stripPresent,
				'CLAIM 3 FINDING a song is not the same as having one to play — the strip stays away until the queue has ' +
					`something in it: a ${SEL.npStrip} appeared after a search with nothing queued`
			)
			.toBe(false);
	}

	/* The row wait above and this click are HARD, because a fixture that indexed no row or cannot be clicked is an
	   environment failure and this repo's ruling is that such a thing must be loud. EVERY WAIT ON THE STRIP'S OWN
	   PRESENCE IS SOFTENED, and that is not laxity — it is what makes this file's "every arm is soft" true. A hard
	   `waitFor` on the strip aborts the test inside the drive, so the arms that would have NAMED the broken
	   contract never run: verified by breaking `live` to `$derived(true)`, where a hard detach-wait in State F
	   swallowed the floor arms and the run reported four arms instead of the arms plus the count. */
	await page.locator(SEL.songRow).first().locator(SEL.addOrSing).first().click({ timeout: 30_000 });
	await page
		.locator(SEL.npStrip)
		.first()
		.waitFor({ state: 'attached', timeout: 20_000 })
		.catch(() => {});
	// A DWELL: the strip has just mounted, so the layout re-measures the container it is now inside.
	await page.waitForTimeout(800);

	/* Measured at 390x844 with one queued entry: --dock-h 91px, dock 91/91.00, strip 45px, tab bar 46px —
	   45 + 46 = 91 exactly, and 91 − 46 = 45, the strip's own height. */
	const live = await take(page, 'C / strip present');
	if (live) {
		expect
			.soft(
				live.stripPresent && live.stripLabel,
				'CLAIM 3 the strip renders with the queue non-empty, and names itself: ' +
					`present=${live.stripPresent}, aria-label=${JSON.stringify(live.stripLabel)} — a section with no accessible ` +
					'name is an unnamed region in the landmark list'
			)
			.toBeTruthy();
		/* THE DEAD-BRIGHT-BUTTON ARM, and it is the one this file most nearly shipped without. The queued song here
		   is a seeded WAV with NO STEMS, so it cannot play yet — the server's `play` handler finds no `nextPlayable`,
		   writes `isPlaying: false`, emits no error and raises no toast. A play control that is enabled in this state
		   is the brightest element on the screen doing nothing silently, which is the defect the strip replaced a
		   whole vaul sheet to be rid of.
		   DISABLED, NOT ABSENT, and both halves are asserted — keying the strip's PRESENCE on playability was tried
		   and was worse: the dock went blank for the whole minute of separation, immediately after the guest's one
		   action. The strip stays, the copy reads "Making karaoke…", and the control is dim. */
		expect
			.soft(
				live.playEnabled,
				'CLAIM 3 a queued song that cannot play yet leaves the play control DISABLED — present, dim, and not ' +
					`a promise the server will break: playEnabled=${live.playEnabled} with one stem-less entry queued`
			)
			.toBe(false);
		// EXACTLY ONE, AND IT IS INSIDE. `.strip` is genuinely ambiguous unscoped — the TV lobby's roster carries
		// the same class, which is why `SEL.npStrip` is dock-scoped and `SEL.strip`/`SEL.stripPerson` name that
		// other element. Measured on a phone surface: 1 inside the dock, 0 outside it.
		expect
			.soft(
				live.stripsInDock === 1 && live.stripsOutsideDock === 0,
				'CLAIM 3 there is ONE now-playing strip on a phone surface and it is inside the dock: ' +
					`${live.stripsInDock} inside .dock, ${live.stripsOutsideDock} outside it (the TV lobby's roster carries the ` +
					'same class, so an unscoped reading passes against the wrong element on /tv)'
			)
			.toBe(true);
		// THREE, not the band's flanking pair: restart, play/pause and skip are all `.btn` inside `.tp` and there
		// is no separate `.disc` any more. An arm demanding two would reject a correct tree.
		expect
			.soft(
				live.transportButtons,
				'CLAIM 3 the strip carries the whole transport — restart, play/pause and skip: ' +
					`${live.transportButtons} matching ${SEL.npTransport}`
			)
			.toBe(3);
		expect
			.soft(
				live.dockVar !== '' &&
					live.dockVar === live.dockInline &&
					Math.abs(parseFloat(live.dockVar) - live.dockRectHeight) <= 1,
				'CLAIM 3 --dock-h tracks the dock through the state change — the measurement re-ran when the strip mounted: ' +
					`--dock-h "${live.dockVar}" (inline "${live.dockInline}") against a dock of ${live.dockRectHeight.toFixed(2)}px`
			)
			.toBe(true);
		// THE SUM, which no single element's reading can see: the container is the strip STACKED ON the tab bar in
		// normal flow, and that is the whole reason they are siblings inside one fixed parent rather than two fixed
		// elements. A gap or an overlap between them is a defect only this arm is positioned to catch.
		expect
			.soft(
				Math.abs((live.stripHeight ?? Number.NaN) + live.tabsHeight - live.dockRectHeight) <= 1,
				'CLAIM 3 the dock is exactly its two rows — no gap and no overlap: ' +
					`strip ${(live.stripHeight ?? Number.NaN).toFixed(2)}px + tab bar ${live.tabsHeight.toFixed(2)}px against a dock ` +
					`of ${live.dockRectHeight.toFixed(2)}px`
			)
			.toBe(true);
	}
	// THE CROSS-STATE ARM, and it is the reason this is one test: the difference the strip makes to the PUBLISHED
	// token must equal the strip's own rendered height. A layout that published a constant, or one that re-measured
	// the wrong box, satisfies every single-state arm above and fails here. Measured 91 − 46 = 45 = the strip.
	if (atRest && live) {
		expect
			.soft(
				Math.abs(parseFloat(live.dockVar) - parseFloat(atRest.dockVar) - (live.stripHeight ?? Number.NaN)) <= 1,
				'CLAIM 3 the strip appearing changes the published height by exactly the strip: ' +
					`--dock-h "${atRest.dockVar}" with no strip and "${live.dockVar}" with one, a delta of ` +
					`${(parseFloat(live.dockVar) - parseFloat(atRest.dockVar)).toFixed(2)}px against a strip that renders ` +
					`${(live.stripHeight ?? Number.NaN).toFixed(2)}px tall`
			)
			.toBe(true);
	}

	/* The inset again WITH THE STRIP UP, because the arrangement's whole claim is that adding a row above the tab
	   bar does not add a second inset term. Measured: dock 91→125px, tab bar 46→80px, and the strip's own height
	   45→45px with padding-bottom 0px at both insets. */
	await setSafeAreaInsets(page, { bottom: SIMULATED_BOTTOM_INSET });
	await page.waitForTimeout(800);
	const liveInset = await take(page, 'C / strip present, simulated bottom inset', SIMULATED_BOTTOM_INSET);
	if (live && liveInset) {
		expect
			.soft(
				Math.abs(liveInset.dockRectHeight - (live.dockRectHeight + SIMULATED_BOTTOM_INSET)) < 1,
				'CLAIM 3 the inset is still ONE term with the strip up: ' +
					`the dock went ${live.dockRectHeight.toFixed(2)}px → ${liveInset.dockRectHeight.toFixed(2)}px under a ` +
					`simulated ${SIMULATED_BOTTOM_INSET}px inset (a second declarer would read ${SIMULATED_BOTTOM_INSET * 2})`
			)
			.toBe(true);
		expect
			.soft(
				liveInset.stripPadBottom === 0 &&
					Math.abs((liveInset.stripHeight ?? Number.NaN) - (live.stripHeight ?? Number.NaN)) < 1,
				'CLAIM 3 the STRIP composes no inset — it is not the bottom-most element, the tab bar below it is: ' +
					`strip padding-bottom ${liveInset.stripPadBottom}px and height ${(live.stripHeight ?? Number.NaN).toFixed(2)}px → ` +
					`${(liveInset.stripHeight ?? Number.NaN).toFixed(2)}px under a simulated ${SIMULATED_BOTTOM_INSET}px inset`
			)
			.toBe(true);
	}
	await setSafeAreaInsets(page, { top: 0, right: 0, bottom: 0, left: 0 });
	await page.waitForTimeout(500);

	/* ── STATE D — NO OPEN STATE. THE MOST VALUABLE BLOCK IN THIS FILE ────────────────────────────────────────
	   The owner reported the old vaul sheet expanding on its own and covering the page. The strip that replaced it
	   has no snap array, no drag, and no geometry read — its height is a function of nothing but whether it
	   renders — and these are the arms that keep it that way. A reintroduced sheet is the regression this guards. */
	const beforeDrag = await take(page, 'D / before the drag');
	if (beforeDrag) {
		expect
			.soft(
				beforeDrag.sheetMachinery,
				'CLAIM 3 no sheet machinery exists on a phone surface at all — not closed, ABSENT: ' +
					`${beforeDrag.sheetMachinery} element(s) matching ${SHEET_MACHINERY}. FOUR of those seven values are ` +
					"also in selectors.ts' RETIRED block (drawer-handle, .np-drawer, .band-slot, .band); the three vaul " +
					'attributes are not in that file at all, and this arm is the stronger check either way — RETIRED ' +
					'warns about a NAME being revived, this measures that the MARKUP is absent from the rendered page'
			)
			.toBe(0);
		expect
			.soft(
				beforeDrag.expandAffordances,
				'CLAIM 3 the strip exposes NO expand affordance — there is no open state to reach: ' +
					`${beforeDrag.expandAffordances} element(s) inside .dock matching ${EXPAND_AFFORDANCES}`
			)
			.toBe(0);
	}

	/* THE DRAG. TOUCH IS THE PRIMARY GESTURE because that is the input the reported defect came from, and vaul
	   listened to pointer and touch events — a mouse drag alone could pass against a touch-only regression. Nine
	   moves climbing 320px, over CDP, because Playwright's own touch API cannot hold a multi-step drag.

	   WHAT IS ASSERTED AND WHAT IS NOT. The dock's published height, its rect height, its rect TOP, its computed
	   transform and the pathname must all be unchanged — measured byte-identical at 91px / 91.00 / 753.00 /
	   `none` / `/`. `window.scrollY` IS DELIBERATELY NOT IN THAT LIST, and the measurement is why: a touch gesture
	   over fixed chrome PANS the document behind it. Driven separately on /settings, which really scrolls (maxScroll
	   1267), the same 320px touch drag moved scrollY 0 → 582 and 0 → 590 across two runs while leaving --dock-h at
	   91px, the dock's rect height at 91.00 and its rect top at 753.00. That pan is the browser's
	   default, it is correct, and it is positive evidence nothing captured the gesture — a vaul sheet would have
	   swallowed it and translated itself instead. Here the column holds the single row the add was made from, so
	   there is nothing to pan and scrollY measures 0 → 0; asserting it would be asserting the fixture's row count.
	   A 300px MOUSE drag is dispatched as the second gesture and is inert on every reading including scrollY. */
	// THE COUNT IS CHECKED FIRST and `boundingBox()` is only called when the strip is really there: `boundingBox`
	// AUTO-WAITS, so on a tree where the strip is absent it blocks until the 180s test budget is gone and every arm
	// after this point goes unreported. Measured while verifying the `live = $derived(true)` break, where the strip
	// legitimately did not render: the run timed out here instead of reporting.
	const stripBox =
		(await page.locator(SEL.npStrip).count()) > 0 ? await page.locator(SEL.npStrip).first().boundingBox() : null;
	expect
		.soft(
			stripBox,
			'CLAIM 3 the strip has a box to drag, or the no-open-state arms below measure nothing: ' +
				`no bounding box for ${SEL.npStrip}`
		)
		.not.toBeNull();
	if (stripBox) {
		const cx = stripBox.x + stripBox.width / 2;
		const cy = stripBox.y + stripBox.height / 2;
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy }] });
		for (let i = 1; i <= 9; i++) {
			await cdp.send('Input.dispatchTouchEvent', {
				type: 'touchMove',
				touchPoints: [{ x: cx, y: cy - (320 * i) / 9 }]
			});
			await page.waitForTimeout(16);
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await cdp.detach();
		await page.waitForTimeout(500);

		await page.mouse.move(cx, cy);
		await page.mouse.down();
		for (let i = 1; i <= 10; i++) {
			await page.mouse.move(cx, cy - (300 * i) / 10);
			await page.waitForTimeout(16);
		}
		await page.mouse.up();
		await page.waitForTimeout(500);
	}
	const afterDrag = await take(page, 'D / after a 320px touch drag and a 300px mouse drag');
	if (beforeDrag && afterDrag) {
		const inert =
			afterDrag.dockVar === beforeDrag.dockVar &&
			Math.abs(afterDrag.dockRectHeight - beforeDrag.dockRectHeight) < 0.5 &&
			Math.abs(afterDrag.dockTop - beforeDrag.dockTop) < 0.5 &&
			afterDrag.dockTransform === beforeDrag.dockTransform &&
			afterDrag.path === beforeDrag.path;
		expect
			.soft(
				inert,
				'CLAIM 3 THE STRIP CANNOT BE DRAGGED OPEN — this is the regression guard for the sheet that expanded on ' +
					'its own and covered the page: ' +
					`--dock-h "${beforeDrag.dockVar}" → "${afterDrag.dockVar}", dock height ` +
					`${beforeDrag.dockRectHeight.toFixed(2)} → ${afterDrag.dockRectHeight.toFixed(2)}px, dock top ` +
					`${beforeDrag.dockTop.toFixed(2)} → ${afterDrag.dockTop.toFixed(2)}, transform ` +
					`${beforeDrag.dockTransform} → ${afterDrag.dockTransform}, pathname ${beforeDrag.path} → ${afterDrag.path} ` +
					`(scrollY ${beforeDrag.scrollY} → ${afterDrag.scrollY} is NOT asserted: a touch gesture over fixed chrome ` +
					'pans the document, which is correct and is evidence nothing captured it)'
			)
			.toBe(true);
		expect
			.soft(
				afterDrag.expandAffordances === 0 && afterDrag.sheetMachinery === 0,
				'CLAIM 3 no sheet appeared DURING the gesture either — the drag opened nothing that a resting read would ' +
					`miss: ${afterDrag.expandAffordances} expand affordance(s) and ${afterDrag.sheetMachinery} sheet element(s) ` +
					'after the drag'
			)
			.toBe(true);
	}

	/* ── STATE E — EVERY SCROLLING COLUMN ────────────────────────────────────────────────────────────────────
	   The strip's ONE action is exercised FIRST, and the /queue visit is reached THROUGH it: "the strip cannot be
	   expanded" is cheap to satisfy by breaking the strip entirely, so asserting in the same breath that its link
	   still navigates is what makes the inertness meaningful rather than merely true. Measured: the click lands on
	   /queue with --dock-h unchanged at 91px. */
	/* GUARDED BY A COUNT for the same reason `boundingBox` above is: `click()` auto-waits, so on a tree with no
	   strip it eats the whole remaining test budget and every arm after this point goes unreported. When the strip
	   is absent the drive falls back to `goto`, so State E still measures five surfaces and the arms that named the
	   missing strip are the ones that speak. */
	const linkClicked = (await page.locator(SEL.npStripLink).count()) > 0;
	if (linkClicked) {
		await page.locator(SEL.npStripLink).first().click();
	} else {
		await page.goto('/queue');
	}
	// Both waits softened for the reason given at the add: the arm below reads the pathname, so a link that goes
	// nowhere must be REPORTED rather than abort the drive.
	await page.waitForURL(/\/queue$/, { timeout: 15_000 }).catch(() => {});
	// THE ROUTE HEADING, not `SEL.queueNowCard`. The now-playing card needs a CURRENT entry, and the add above
	// produced a `queued` one: the seeded WAVs have no stems, so the row's action is process-and-queue and nothing
	// is playing yet — which is `canStart`, the strip's second branch. Measured: waiting on `.now` here times out
	// on a correct tree. The heading is present on either branch.
	await page
		.locator(SEL.pageHeading)
		.first()
		.waitFor({ state: 'attached', timeout: 15_000 })
		.catch(() => {});
	await page.waitForTimeout(600);
	const queueRest = await take(page, 'E /queue at rest');
	if (live && queueRest) {
		// `linkClicked` IS PART OF THE CLAIM, not bookkeeping: without it the goto fallback above would satisfy
		// "landed on /queue" without the strip's link having been exercised at all, which is the false pass this
		// arm exists to prevent.
		expect
			.soft(
				linkClicked && queueRest.path === '/queue' && queueRest.dockVar === live.dockVar,
				"CLAIM 3 the strip's one action still WORKS — inert is not the same as broken: " +
					`${linkClicked ? `clicking ${SEL.npStripLink}` : `NO ${SEL.npStripLink} to click, so the drive used goto and`} ` +
					`landed on ${queueRest.path} with --dock-h "${live.dockVar}" → "${queueRest.dockVar}"`
			)
			.toBe(true);
	}
	await toEnd(page);
	await take(page, 'E /queue at max scroll');

	/* /settings and /stats are driven as well as the three tabs, and that was forced by measurement rather than
	   thoroughness: both render the dock, both really scroll, and /stats is the one surface whose reservation is
	   NOT on `main` — see the note on the reserve walk. `/song/[mediaId]` is the known gap: it needs a mediaId and
	   adds no surface class this claim depends on. */
	for (const path of ['/library', '/settings', '/stats']) {
		await page.goto(path);
		await page.locator(SEL.dock).first().waitFor({ state: 'attached', timeout: 15_000 });
		await page.waitForTimeout(900);
		await take(page, `E ${path} at rest`);
		await toEnd(page);
		await take(page, `E ${path} at max scroll`);
	}

	/* `/` WITH RESULTS, the only surface the version before this one measured. Narrowed to `local` for the same
	   reason as the add above. The LONGEST column this drive reaches is /settings, not this one — 1267px of scroll
	   against at most ~800 here.

	   ITS SIZE IS NOT A FIXTURE CONSTANT, and that is worth spelling out because the figures look like one.
	   `world.awaitDemoTrack()` up at State C polls `/api/search?q=caroline` with NO `?source=`, so on a box that can
	   reach YouTube Music that poll MATERIALISES remote hits into the catalog — and /api/search partitions the WHOLE
	   catalog against the query, not only the resolvers it ran. Narrowing the SOURCE narrows which resolvers are
	   asked, never which catalog rows come back, so this one-letter query answers with whatever that poll left
	   behind. Measured at 390x844 on both branches, isolated by re-running the identical drive with the index poll
	   itself narrowed to `local`:
	     · remote leg answered — 14 rows, 92 leaves swept, 6 of them under the dock at rest, maxScroll 795;
	     · remote leg absent — 2 rows, 30 leaves, NONE under the dock at rest, maxScroll 0, so it does not scroll.
	   EVERY ARM ON THIS SURFACE HOLDS IN BOTH, which is why the class it falls into is allowed to move with the box:
	   reserve 119px against a 91px dock, a leaf population far over the floor of 2, zero occlusion at max scroll,
	   and the same token as everywhere else. The scrolling/non-scrolling pair below is carried by /settings and
	   /stats against /queue and /library, so it never depends on this surface either. */
	await page.goto('/');
	await openBrowse(page);
	await page.locator(SEL.searchSource).first().selectOption('local');
	await fill(page, SEL.search, 'a');
	await page
		.locator(SEL.songRow)
		.first()
		.waitFor({ state: 'attached', timeout: 20_000 })
		.catch(() => {});
	// A DWELL: the search debounce is 150ms, so this lets the result set land and the rows paint.
	await page.waitForTimeout(1_000);
	await take(page, 'E / with results at rest');
	await toEnd(page);
	await take(page, 'E / with results at max scroll');

	/* The per-surface arms, over every State E reading at once. Each is soft and each names its surface, so one
	   run reports every surface that broke rather than the first. */
	const surfaces = readings.filter((r) => r.state.startsWith('E '));
	for (const r of surfaces) {
		expect
			.soft(
				r.dockTop >= -1 && r.dockBottom <= r.innerHeight + 1,
				`CLAIM 3 the dock sits fully on screen on ${r.state} — no bleed below, no clip above: ` +
					`${r.dockTop.toFixed(2)}..${r.dockBottom.toFixed(2)} of a ${r.innerHeight}px viewport`
			)
			.toBe(true);
		// THE TOKEN-ARITHMETIC HALF of the reservation. Measured at 390x844 with the strip up: 111px on /queue, 119
		// on /library, 119 on /settings, 139 on /stats and 119 on `/` with results, against a dock of 91.
		expect
			.soft(
				r.reserve,
				`CLAIM 3 the column RESERVES the dock on ${r.state} rather than being overlapped by it — read off the ` +
					`whole chain main → .app-shell, because /stats declares it on the section and not on main: ` +
					`max padding-bottom ${r.reserve}px against a ${r.dockRectHeight.toFixed(2)}px dock. Chain: ` +
					r.reserveChain.join(' · ')
			)
			.toBeGreaterThanOrEqual(r.dockRectHeight);
		/* A FLOOR, not a check: a sweep that found no leaves would report zero occlusion over an empty set, which is
		   the one way this arm can lie. TWO is deliberately low and the reason is a measurement, not caution — on
		   this fixture every demo WAV is stem-less, so /library is its empty box and legitimately renders only FOUR
		   leaves. Populations read off this spec's own sweep at 390x844: 43 on /settings, 17 on /stats, 12 on /queue, 4
		   on /library, and either 30 or 92 on `/` with results depending on whether the remote leg answered — see the
		   note on that surface. A floor near the real minimum would red on a route doing nothing wrong; the failure
		   worth catching is zero. */
		expect
			.soft(
				r.leaves,
				`CLAIM 3 the occlusion sweep on ${r.state} saw a real population to sweep: ${r.leaves} leaf element(s) ` +
					'inside .app-shell'
			)
			.toBeGreaterThanOrEqual(2);
	}
	// THE GEOMETRIC HALF, and only AT MAX SCROLL. At the top of a long list rows under the chrome are what
	// scrolling is FOR — measured at 390x844: 4 leaves under the dock at the top of /settings, 1 on /stats, and 6 on
	// `/` with results on the branch where the remote leg answered (0 on the branch where it did not, since that
	// column does not scroll). At the END it is 0 on every surface, with the fixed/sticky filter and without it. An
	// at-rest version of this arm would red a correct tree, which the version before this one already knew.
	for (const r of surfaces.filter((s) => s.state.endsWith('at max scroll'))) {
		expect
			.soft(
				r.occluded,
				`CLAIM 3 NO CONTENT sits under the dock on ${r.state} — this is the reservation read geometrically, which ` +
					`needs no per-route knowledge: ${r.occluded} of ${r.leaves} leaf element(s) intersect the dock at ` +
					`${r.dockTop.toFixed(2)}..${r.dockBottom.toFixed(2)}` +
					(r.occludedNames.length ? ` — first offenders: ${r.occludedNames.join(', ')}` : '')
			)
			.toBe(0);
	}
	// ONE ELEMENT, ONE TOKEN, no per-surface drift. --dock-h is written once by the layout, so a disagreement
	// between surfaces means the dock rendered to a different height on one of them while each column reserved
	// whatever the token last said. No single-surface reading can see that; only the comparison can. Measured
	// 91px on all five surfaces in both scroll positions.
	const published = [...new Set(surfaces.map((r) => r.dockVar))];
	expect
		.soft(
			published.length,
			'CLAIM 3 --dock-h is the SAME on every surface — one element, one token: ' +
				`published ${JSON.stringify(published)} across ${surfaces.map((r) => r.state).join(', ')}`
		)
		.toBe(1);
	/* THE SHORT CASE, generalised onto real screens. A dock whose measured height only survives while content is
	   pressing on it is a dock whose height is a coincidence — so the drive must have reached BOTH classes, and
	   it must PROVE it rather than assume, or dropping the forced non-matching query it replaces would be a
	   quiet loosening. Measured at 390x844: /queue and /library cannot scroll at all on this fixture (maxScroll 0
	   each), while /settings (1267) and /stats (275) are static columns and scroll whatever the network answered.
	   BOTH CLASSES ARE CARRIED BY THOSE FOUR ALONE,
	   deliberately — `/` with results falls on whichever side the remote leg put it (795 or 0; see the note on that
	   surface), so the pair holds without it. */
	const scrolled = surfaces.filter((r) => r.maxScroll > 0).map((r) => `${r.state} maxScroll=${r.maxScroll}`);
	const unscrollable = surfaces.filter((r) => r.maxScroll === 0).map((r) => r.state);
	expect
		.soft(
			scrolled.length > 0 && unscrollable.length > 0,
			'CLAIM 3 the drive measured the dock on a column that REALLY SCROLLED and on one that could not — the ' +
				'height is measured, not a coincidence of content pressing on it: ' +
				`scrolling surfaces [${scrolled.join(', ')}], non-scrolling surfaces [${unscrollable.join(', ')}]`
		)
		.toBe(true);

	/* ── STATE F — BACK TO ABSENT, AND THE ROUND TRIP CLOSES ─────────────────────────────────────────────────
	   Appearing proves the bind fires. DISAPPEARING proves the chrome does not keep a reservation for a row it no
	   longer renders, which is the half most likely to break and the half no single-state reading can reach.
	   Measured: 46px → 91px → 46px. */
	await page.goto('/queue');
	await page
		.locator(SEL.npStrip)
		.first()
		.waitFor({ state: 'attached', timeout: 15_000 })
		.catch(() => {});
	await page.waitForTimeout(600);
	await take(page, 'F /queue before the entry is removed');
	const removable = await page.locator(SEL.queueRemove).count();
	expect
		.soft(
			removable,
			'CLAIM 3 /queue offers a way to empty the queue, which is the only way to drive the strip back to ABSENT: ' +
				`${removable} ${SEL.queueRemove} on /queue with one entry`
		)
		.toBeGreaterThanOrEqual(1);
	if (removable > 0) {
		await page.locator(SEL.queueRemove).first().click();
		await page
			.locator(SEL.npStrip)
			.first()
			.waitFor({ state: 'detached', timeout: 15_000 })
			.catch(() => {});
		await page.waitForTimeout(800);
	}
	const emptied = await take(page, 'F /queue after the entry is removed');
	if (atRest && emptied) {
		expect
			.soft(
				emptied.stripPresent,
				'CLAIM 3 emptying the queue takes the strip away again — there is nothing left to act on: ' +
					`a ${SEL.npStrip} is still present after the last entry was removed`
			)
			.toBe(false);
		expect
			.soft(
				Math.abs(emptied.dockRectHeight - emptied.tabsHeight) <= 1 &&
					Math.abs(parseFloat(emptied.dockVar) - emptied.dockRectHeight) <= 1,
				"CLAIM 3 the dock gives the strip's height BACK — no reservation is kept for a row that stopped " +
					`rendering: --dock-h "${emptied.dockVar}" against a dock of ${emptied.dockRectHeight.toFixed(2)}px and a ` +
					`tab bar of ${emptied.tabsHeight.toFixed(2)}px`
			)
			.toBe(true);
		expect
			.soft(
				Math.abs(parseFloat(emptied.dockVar) - parseFloat(atRest.dockVar)) <= 1,
				'CLAIM 3 THE ROUND TRIP CLOSES — the published height returns to its at-rest value: ' +
					`--dock-h "${atRest.dockVar}" at rest, "${live?.dockVar ?? 'unread'}" with the strip up, ` +
					`"${emptied.dockVar}" after the queue was emptied`
			)
			.toBe(true);
	}

	/* THE TEARDOWN IS CONTRACTUAL, not tidy: an inline custom property on :root outranks every stylesheet, so a
	   left-behind value would pad the television's stage by a dock it has not got. Measured on /tv at 390x844:
	   the inline value is the EMPTY STRING, there are 0 `.dock`s — and 1 `.strip`, the lobby roster, which is the
	   whole reason every dock selector in this file is scoped. */
	await page.goto('/tv');
	await page.waitForTimeout(1_200);
	const tv = await page.evaluate(() => ({
		inline: document.documentElement.style.getPropertyValue('--dock-h'),
		computed: getComputedStyle(document.documentElement).getPropertyValue('--dock-h').trim(),
		docks: document.querySelectorAll('.dock').length,
		strips: document.querySelectorAll('.strip').length
	}));
	expect
		.soft(
			tv.inline === '' && tv.computed === '' && tv.docks === 0,
			'CLAIM 3 the television gets NO --dock-h, so var(--dock-h, 0px) falls back to 0 there: ' +
				`inline ${JSON.stringify(tv.inline)}, computed ${JSON.stringify(tv.computed)}, ${tv.docks} .dock(s) on /tv ` +
				`(${tv.strips} .strip, which is the lobby roster and not the now-playing strip)`
		)
		.toBe(true);

	/* THE NON-VACUITY FLOOR. This rewrite's dominant failure mode is a drive that silently never reaches the
	   strip-PRESENT state — the strip needs a real indexed library row queued — after which every arm above
	   reports satisfied over the one state the drive did reach, INCLUDING the four cross-state arms that are the
	   reason this is one test. A counted floor is what the register exists for, and per its own rule a firing
	   floor is a FINDING, never a number to adjust. */
	expect
		.soft(
			readings.length,
			`CLAIM 3 the drive really reached every state it measures: ${readings.length} reading(s) taken — ` +
				readings.map((r) => r.state).join(' | ')
		)
		.toBeGreaterThanOrEqual(FLOORS.dockStatesMeasured);
	// AND BOTH SIDES OF THE BRANCH, which a count alone cannot say: nineteen readings of a strip-absent room
	// would clear the floor above and prove nothing about the state change.
	expect
		.soft(
			readings.some((r) => r.stripPresent) && readings.some((r) => !r.stripPresent),
			'CLAIM 3 the drive reached BOTH strip states, which is what makes the cross-state arms mean anything: ' +
				`${readings.filter((r) => r.stripPresent).length} reading(s) with a strip, ` +
				`${readings.filter((r) => !r.stripPresent).length} without`
		)
		.toBe(true);
});
