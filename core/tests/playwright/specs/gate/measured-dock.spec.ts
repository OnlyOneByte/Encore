/*
 * CLAIM 3: the docked band's published height, its safe-area term, and the reservation every scrolling column
 * makes for it — measured in FOUR STATES of one phone: at rest, with results up, scrolled to the end of the
 * list, and with a column too short to scroll. Ported from tests/e2e/gates/measured-design.mjs.
 *
 * ONE TEST, because two of its arms are CROSS-STATE: the band must render to the same height at rest and with
 * results up, and the short case only means something next to the states where content was pressing on the
 * band. No single-state reading can see either. Every arm is SOFT, so one run reports every broken arm.
 *
 * THE ROW, NOT THE STRIP — the layout publishes `--dock-h` from `SEL.dockRow`'s clientHeight and a column must
 * clear the WHOLE row, so comparing the token against `.band` (24px shorter) reports a broken contract where
 * there is none.
 */
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { SIMULATED_BOTTOM_INSET } from './measured-design-register';
import { fill, openBrowse, setSafeAreaInsets } from './measured-design-support';
import type { Page } from '@playwright/test';

/**
 * TWO ELEMENTS, TWO CLAIMS. RESERVATION is about the ROW; the SAFE-AREA term is declared on the STRIP
 * `SEL.homeReady`. Reading the row for both measures padding-bottom 0 at every inset, reporting a composed
 * term as missing when it is declared one element further in.
 */
async function readDock(page: Page) {
	return page.evaluate(
		({ dockRow, homeReady, mainColumn }) => {
			const dock = document.querySelector(dockRow);
			if (!dock) return null;
			const dr = dock.getBoundingClientRect();
			const main = document.querySelector(mainColumn)!;
			return {
				dockVar: getComputedStyle(document.documentElement).getPropertyValue('--dock-h').trim(),
				dockInline: document.documentElement.style.getPropertyValue('--dock-h').trim(),
				dockClientHeight: dock.clientHeight,
				// The OUTER box, and it is the one the claim is about — see the note at the arm below.
				dockOuterHeight: dr.height,
				dockTop: dr.top,
				dockBottom: dr.bottom,
				dockPadBottom: parseFloat(getComputedStyle(dock).paddingBottom),
				// The safe-area term lives on the STRIP, not on the row — see the note above this probe.
				stripPadBottom: (() => {
					const strip = document.querySelector(homeReady);
					return strip ? parseFloat(getComputedStyle(strip).paddingBottom) : Number.NaN;
				})(),
				innerHeight: window.innerHeight,
				mainPadBottom: parseFloat(getComputedStyle(main).paddingBottom)
			};
		},
		{ dockRow: SEL.dockRow, homeReady: SEL.homeReady, mainColumn: SEL.mainColumn }
	);
}

test('CLAIM 3 the docked band publishes its real height, composes the safe-area inset, and is reserved in every state', async ({
	world
}) => {
	const page = await world.openPhone(`Dock${Date.now() % 1_000_000}`);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	await page.locator(SEL.homeReady).first().waitFor({ state: 'attached', timeout: 15_000 });
	// A DWELL, not a missing auto-wait: `--dock-h` is written by the layout's own measurement of a row that has
	// just animated in, so this lets the measured write land before anything reads it back.
	await page.waitForTimeout(600);

	const dock = await readDock(page);
	if (!dock) {
		expect
			.soft(
				dock,
				'CLAIM 3 the docked band is rendered on the joined home, so its contract is measurable: ' +
					`no ${SEL.dockRow} found on / — the layout mounts the docked row for a joined singer, so its absence is ` +
					'either an unjoined drive or the row itself'
			)
			.not.toBeNull();
	} else {
		// WHICH HEIGHT, by exactly the 1px that would red this arm on a correct app: `--dock-h` is
		// `bind:clientHeight` on a wrapper with no padding or border, so it is the OUTER box, and `.band`'s own
		// `clientHeight` EXCLUDES its 1px border-top. Use `getBoundingClientRect()`.
		//
		// The 1px tolerance is `clientHeight`'s INTEGER rounding, not slack — the defects this catches are wrong
		// by tens of pixels. The computed-vs-inline pair is EXACT: that is the half saying the value was written
		// by the layout's measurement rather than inherited from a stylesheet.
		expect
			.soft(
				dock.dockVar !== '' &&
					dock.dockVar === dock.dockInline &&
					Math.abs(parseFloat(dock.dockVar) - dock.dockOuterHeight) <= 1,
				"CLAIM 3 --dock-h equals the docked band's REAL rendered height — the contract every docked control offsets from: " +
					`--dock-h resolved "${dock.dockVar}" (inline "${dock.dockInline}") against a band whose outer box is ` +
					`${dock.dockOuterHeight.toFixed(1)}px (clientHeight ${dock.dockClientHeight}px, which excludes its 1px top border)`
			)
			.toBe(true);
		expect
			.soft(
				dock.dockTop >= -1 && dock.dockBottom <= dock.innerHeight + 1,
				'CLAIM 3 the docked band sits fully on screen — no bleed below, no clip above: ' +
					`band occupies ${dock.dockTop.toFixed(1)}..${dock.dockBottom.toFixed(1)} of a ${dock.innerHeight}px viewport ` +
					'(1px of sub-pixel slack allowed)'
			)
			.toBe(true);
		expect
			.soft(
				dock.mainPadBottom,
				'CLAIM 3 the scrolling column RESERVES the band rather than being overlapped by it: ' +
					`main padding-bottom ${dock.mainPadBottom}px against a ${dock.dockClientHeight}px band`
			)
			.toBeGreaterThanOrEqual(dock.dockClientHeight);

		// The safe-area term, proven by giving the browser a non-zero inset to resolve.
		await setSafeAreaInsets(page, { bottom: SIMULATED_BOTTOM_INSET });
		// A DWELL: the override is a compositor-side change, so the cascade re-resolves and repaints before the
		// padding can be read back.
		await page.waitForTimeout(600);
		const dockInset = await readDock(page);
		expect
			.soft(
				dockInset !== null && Math.abs(dockInset.stripPadBottom - (dock.stripPadBottom + SIMULATED_BOTTOM_INSET)) < 1,
				`CLAIM 3 the band's bottom padding really composes env(safe-area-inset-bottom) — +${SIMULATED_BOTTOM_INSET}px ` +
					`under a simulated inset: the band strip's padding-bottom ${dock.stripPadBottom}px at inset 0, ` +
					`${dockInset?.stripPadBottom}px at inset ${SIMULATED_BOTTOM_INSET}px`
			)
			.toBe(true);
		await setSafeAreaInsets(page, { top: 0, right: 0, bottom: 0, left: 0 });
	}

	// CLAIM 3 IN THE SEARCH VIEW: the same band in the second STATE, COMPARED against the resting one — a
	// results list is longer than a queue, so "scrolled to the very end" is a different row here. The reflow
	// half is NOT re-asserted: it was owned by tests/guards/layout/phone-inventory.test.ts.
	await page.setViewportSize({ width: 390, height: 844 });
	await openBrowse(page);
	await fill(page, SEL.search, 'a');
	await page
		.locator(SEL.songRow)
		.first()
		.waitFor({ state: 'attached', timeout: 15_000 })
		.catch(() => {});
	// A DWELL: the search debounce is 150ms, so this lets the result set land and the rows paint before any
	// geometry is read off them.
	await page.waitForTimeout(800);

	// The band's two flanking transport controls — restart and skip — addressed by STRUCTURE: the group holds
	// the disc plus these two, so `.btn` inside it is exactly the pair.
	const bandSideControls = `${SEL.homeReady} .tp .btn`;

	const browse = await page.evaluate(
		({ dockRow, sideControls, search, mainColumn, songRow, bandTransport }) => {
			const dock = document.querySelector(dockRow);
			const sides = [...document.querySelectorAll(sideControls)];
			const field = document.querySelector(search);
			const main = document.querySelector(mainColumn);
			if (!dock || sides.length !== 2 || !field || !main) return null;
			const dr = dock.getBoundingClientRect();

			const fr = field.getBoundingClientRect();
			const rows = [...document.querySelectorAll(songRow)].map((r) => {
				const b = r.getBoundingClientRect();
				return { top: b.top, bottom: b.bottom };
			});
			return {
				dockVar: getComputedStyle(document.documentElement).getPropertyValue('--dock-h').trim(),
				dockInline: document.documentElement.style.getPropertyValue('--dock-h').trim(),
				dockClientHeight: dock.clientHeight,
				dockOuterHeight: dr.height,
				dockTop: dr.top,
				dockBottom: dr.bottom,
				sideCentresY: sides.map((el) => {
					const b = el.getBoundingClientRect();
					return b.top + b.height / 2;
				}),
				discCentreY: (() => {
					const d = document.querySelector(bandTransport);
					if (!d) return null;
					const b = d.getBoundingClientRect();
					return b.top + b.height / 2;
				})(),
				fieldCentreY: fr.top + fr.height / 2,
				innerHeight: window.innerHeight,
				mainPadBottom: parseFloat(getComputedStyle(main).paddingBottom),
				rowCount: rows.length,
				occludedRows: rows.filter((r) => r.bottom > dr.top + 1 && r.top < dr.bottom - 1).length,
				// The FIRST row is the best match on a list that reads downward, so its clearance is the one that
				// can be asserted at rest — see the arm below.
				firstRowTop: rows.length ? rows[0].top : null,
				firstRowBottom: rows.length ? rows[0].bottom : null
			};
		},
		{
			dockRow: SEL.dockRow,
			sideControls: bandSideControls,
			search: SEL.search,
			mainColumn: SEL.mainColumn,
			songRow: SEL.songRow,
			bandTransport: SEL.bandTransport
		}
	);

	if (!browse) {
		expect
			.soft(
				browse,
				'CLAIM 3 the search view renders the docked band, its magnifier, its field and its column, so the contract is measurable: ' +
					`no ${SEL.dockRow} / two ${bandSideControls} / ${SEL.search} / ${SEL.mainColumn} found on / with results showing`
			)
			.not.toBeNull();
	} else {
		expect
			.soft(
				browse.dockVar !== '' &&
					browse.dockVar === browse.dockInline &&
					Math.abs(parseFloat(browse.dockVar) - browse.dockOuterHeight) <= 1,
				"CLAIM 3 --dock-h in the search view is the BAND's REAL rendered height — the contract every column offsets from: " +
					`--dock-h resolved "${browse.dockVar}" (inline "${browse.dockInline}") against a band whose outer box is ` +
					`${browse.dockOuterHeight.toFixed(1)}px (see the height note on the / arm above)`
			)
			.toBe(true);
		// `--dock-h` is written once by the layout, so a per-surface disagreement means the band rendered to a
		// different height here than on `/` while each `main` reserved whatever the token last said. Neither
		// single-surface reading above can see that; only the comparison can.
		expect
			.soft(
				dock !== null && Math.abs(browse.dockOuterHeight - dock.dockOuterHeight) <= 1,
				'CLAIM 3 the ONE band renders to the SAME height at rest and with results up — one element, one token, no per-state drift: ' +
					(dock === null
						? 'the / reading is missing, so the two surfaces could not be compared'
						: `band outer box is ${dock.dockOuterHeight.toFixed(1)}px at rest and ${browse.dockOuterHeight.toFixed(1)}px with results up`)
			)
			.toBe(true);
		expect
			.soft(
				browse.dockTop >= -1 && browse.dockBottom <= browse.innerHeight + 1,
				'CLAIM 3 the band sits fully on screen in the search view — no bleed below, no clip above: ' +
					`band occupies ${browse.dockTop.toFixed(1)}..${browse.dockBottom.toFixed(1)} of a ${browse.innerHeight}px viewport`
			)
			.toBe(true);
		expect
			.soft(
				browse.mainPadBottom,
				'CLAIM 3 the find column RESERVES the band rather than being overlapped by it: ' +
					`main padding-bottom ${browse.mainPadBottom}px against a ${browse.dockClientHeight}px band`
			)
			.toBeGreaterThanOrEqual(browse.dockClientHeight);
		// THE CRITERION: the controls a guest reaches mid-song must not cost a regrip, so the TRANSPORT belongs in
		// the bottom third; one reading covers every phone surface because the band is chrome. NOT the search
		// field, which sits at the top of the column by design — this arm would assert the opposite.
		const thumbLine = (browse.innerHeight * 2) / 3;
		const transportCentres = [...browse.sideCentresY, browse.discCentreY];
		expect
			.soft(
				transportCentres.every((y) => typeof y === 'number' && y > thumbLine),
				'CLAIM 3 the whole TRANSPORT sits in the thumb zone — restart, play/pause and skip in the bottom third: ' +
					`transport centres at ${transportCentres.map((y) => (typeof y === 'number' ? y.toFixed(1) : String(y))).join(', ')} ` +
					`of ${browse.innerHeight}px; thumb zone starts at ${thumbLine.toFixed(1)} (the search field is at ` +
					`y=${browse.fieldCentreY.toFixed(1)}, top of the column, by design)`
			)
			.toBe(true);
		// A floor, not a check: with no rows the occlusion arms would pass over nothing at all.
		expect
			.soft(
				browse.rowCount,
				`CLAIM 3 the find drive rendered a real result stack — >=1 row to measure: ${browse.rowCount} rows rendered for the query "a"`
			)
			.toBeGreaterThanOrEqual(1);
		expect
			.soft(
				browse.firstRowBottom !== null && browse.firstRowBottom <= browse.dockTop + 1,
				'CLAIM 3 the TOP of the ranking is clear of the band at rest — the best match is never under the chrome: ' +
					`best-match row occupies ${(browse.firstRowTop ?? NaN).toFixed(1)}..${(browse.firstRowBottom ?? NaN).toFixed(1)} ` +
					`against a band starting at y=${browse.dockTop.toFixed(1)} (${browse.occludedRows} of ${browse.rowCount} rows sit ` +
					'under it further down, which is what scrolling is for)'
			)
			.toBe(true);
	}

	// CLAIM 3, THE RESERVATION UNDER SCROLL. The END of the list is the only position where `main`'s
	// `calc(var(--dock-h, 0px) + 28px)` can be observed doing its job: at rest the last row of a long list is
	// off-screen, so the at-rest occlusion arm above passes over a row nobody can see.
	await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
	// A DWELL: there is no smooth scrolling in this app, so this is paint settle, not animation.
	await page.waitForTimeout(400);
	const end = await page.evaluate(
		({ dockRow, songRow }) => {
			const dock = document.querySelector(dockRow);
			const rows = [...document.querySelectorAll(songRow)];
			if (!dock || rows.length === 0) return null;
			const dr = dock.getBoundingClientRect();
			const last = rows[rows.length - 1].getBoundingClientRect();
			return {
				dockTop: dr.top,
				dockBottom: dr.bottom,
				lastRowBottom: last.bottom,
				occludedRows: rows.filter((r) => {
					const b = r.getBoundingClientRect();
					return b.bottom > dr.top + 1 && b.top < dr.bottom - 1;
				}).length,
				rowCount: rows.length,
				scrollY: Math.round(window.scrollY),
				maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight)
			};
		},
		{ dockRow: SEL.dockRow, songRow: SEL.songRow }
	);
	if (!end) {
		expect
			.soft(
				end,
				'CLAIM 3 the find surface still has a band and rows to measure at the end of the list: ' +
					`no ${SEL.dockRow} or no ${SEL.songRow} in the search view after scrolling to the end`
			)
			.not.toBeNull();
	} else {
		// If the column never scrolled there is no end to be at, and the two arms below would pass on the at-rest
		// layout the block above already measured.
		expect
			.soft(
				end.scrollY,
				'CLAIM 3 the drive really reached the END of the list — the reservation is measured where it can fail: ' +
					`scrolled to ${end.scrollY} of a possible ${end.maxScroll} (a result set shorter than the viewport reports 0/0, which is a pass)`
			)
			.toBeGreaterThanOrEqual(end.maxScroll - 1);
		expect
			.soft(
				end.lastRowBottom,
				'CLAIM 3 the LAST row clears the band with the list scrolled to its end — what the reservation is for: ' +
					`last row's bottom is at y=${end.lastRowBottom.toFixed(1)} against a band starting at y=${end.dockTop.toFixed(1)}`
			)
			.toBeLessThanOrEqual(end.dockTop + 1);
		expect
			.soft(
				end.occludedRows,
				'CLAIM 3 no result row is occluded by the band at the end of the list: ' +
					`${end.occludedRows} of ${end.rowCount} rows intersect the band at ${end.dockTop.toFixed(1)}..${end.dockBottom.toFixed(1)}`
			)
			.toBe(0);
	}

	// CLAIM 3, THE SHORT CASE: a column shorter than the viewport, unable to scroll. A band whose measured
	// height only survives while content pushes against it is a band whose height is a coincidence. The empty
	// line sits near the TOP by design; wherever it sits, it must not be under the band.
	await fill(page, SEL.search, 'zzzzznotasongzzzzz');
	await page
		.locator(SEL.empty)
		.first()
		.waitFor({ state: 'attached', timeout: 15_000 })
		.catch(() => {});
	// A DWELL: the column collapsing to the empty line is a layout change, and the band's own height is what is
	// being read next.
	await page.waitForTimeout(900);
	const short = await page.evaluate(
		({ dockRow, empty, songRow }) => {
			const dock = document.querySelector(dockRow);
			const emptyEl = document.querySelector(empty);
			if (!dock || !emptyEl) return null;
			const dr = dock.getBoundingClientRect();
			const er = emptyEl.getBoundingClientRect();
			return {
				dockVar: getComputedStyle(document.documentElement).getPropertyValue('--dock-h').trim(),
				dockInline: document.documentElement.style.getPropertyValue('--dock-h').trim(),
				dockClientHeight: dock.clientHeight,
				dockOuterHeight: dr.height,
				dockTop: dr.top,
				dockBottom: dr.bottom,
				emptyTop: er.top,
				emptyBottom: er.bottom,
				rowCount: document.querySelectorAll(songRow).length,
				scrollHeight: document.documentElement.scrollHeight,
				innerHeight: window.innerHeight
			};
		},
		{ dockRow: SEL.dockRow, empty: SEL.empty, songRow: SEL.songRow }
	);
	if (!short) {
		expect
			.soft(
				short,
				'CLAIM 3 a non-matching query leaves one empty-state line to measure the short case against: ' +
					`no ${SEL.empty} found on / after a non-matching query`
			)
			.not.toBeNull();
	} else {
		expect
			.soft(
				short.rowCount === 0 && short.scrollHeight <= short.innerHeight + 1,
				'CLAIM 3 the short case really is short — the column cannot scroll, so nothing is pressing on the band: ' +
					`${short.rowCount} rows, scrollHeight ${short.scrollHeight} against innerHeight ${short.innerHeight}`
			)
			.toBe(true);
		expect
			.soft(
				short.dockVar !== '' &&
					short.dockVar === short.dockInline &&
					Math.abs(parseFloat(short.dockVar) - short.dockOuterHeight) <= 1,
				"CLAIM 3 --dock-h still equals the band's rendered height with an EMPTY column — the height is measured, not a " +
					`coincidence of content: --dock-h resolved "${short.dockVar}" (inline "${short.dockInline}") against a band whose ` +
					`outer box is ${short.dockOuterHeight.toFixed(1)}px`
			)
			.toBe(true);
		expect
			.soft(
				short.emptyBottom,
				'CLAIM 3 the empty-state line is not occluded by the band: ' +
					`empty-state line occupies ${short.emptyTop.toFixed(1)}..${short.emptyBottom.toFixed(1)} against a band starting at ` +
					`y=${short.dockTop.toFixed(1)}`
			)
			.toBeLessThanOrEqual(short.dockTop + 1);
	}
});
