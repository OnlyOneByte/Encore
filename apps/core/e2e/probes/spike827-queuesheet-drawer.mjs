/*
 * #827 SPIKE — QueueSheet on the shadcn/vaul drawer: the four do-not-regress numbers, measured on the
 * INCUMBENT and on the PORT in one browser session, at the same viewports, with the same instrument.
 *
 * WHY A RENDERED PROBE AND NOT A UNIT TEST. Three of the four numbers are not decidable from source.
 * `82dvh` is a unit that only a layout engine resolves; `env(safe-area-inset-bottom, 0px)` reads as
 * literally nothing without an inset to resolve against — a headless run with no override measures
 * 10px whether the term is present or was deleted, which is why this probe pushes a real inset through
 * `Emulation.setSafeAreaInsetsOverride`; and `--peek-h`'s whole point is that a JS-measured inline write
 * on `documentElement` OUTRANKS the `@media (max-height: 480px)` rule, a precedence fact between two
 * writers that no scan of either file can see. Encore has no jsdom, so `bun test` cannot host any of it.
 *
 * WHAT THE PORT CHANGES, which is what makes measuring the port separately necessary: vaul computes the
 * sheet's offset in JS (`use-snap-points.svelte.js:44-54`) and writes an inline
 * `transform: translate3d(0, Npx, 0)`, so `--peek-h` stops being read by CSS and the peek height must be
 * handed in as a px snap point instead. The 82dvh cap survives only as far as it is still the binding
 * constraint — this probe measures whether it is.
 *
 *   # gallery only: no join, no room, no cook needed
 *   cd apps/core
 *   bun run build
 *   ENCORE_EPHEMERAL=1 PORT=5271 HOST=127.0.0.1 bun run ./server.ts &
 *   EPORT=5271 bun e2e/probes/spike827-queuesheet-drawer.mjs
 *
 * Exit 0 all measured and matching / 1 a real regression / 2 the environment could not host the test.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from '../cdp.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 */

const PORT = process.env.EPORT ?? '3000';
const base = 'http://127.0.0.1:' + PORT;
const CDP_PORT = Number(process.env.CDP_PORT ?? 9391);
const SCRATCH = process.env.E2E_SCRATCH ?? process.env.KIROCREW_SCRATCH ?? '/tmp';
const SHOTS = join(SCRATCH, 'shots-827');

/* The incumbent's own values, read off `QueueSheet.svelte` and `app.css` at d325c64. Named here so a
   drift in either direction is a named failure rather than a number nobody recognises. */
const CAP_FRACTION = 0.82; // QueueSheet.svelte:198  max-height: 82dvh
const PEEK_PAD_BASE = 10; // QueueSheet.svelte:215  calc(10px + env(safe-area-inset-bottom, 0px))
const BODY_PAD_BASE = 20; // QueueSheet.svelte:317  calc(20px + env(safe-area-inset-bottom, 0px))
const PEEK_H_FALLBACK = 132; // app.css:162          --peek-h: 132px
const PEEK_H_SHORT = 84; // routes/+page.svelte:1970 @media (max-height: 480px) -> 84px
const INSET = 34; // the iOS home indicator, the inset all four numbers exist for

/** @type {{ name: string, ok: boolean }[]} */
const checks = [];
/** @param {string} name @param {unknown} ok @param {string} [detail] */
function check(name, ok, detail) {
	checks.push({ name, ok: !!ok });
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok || !detail ? '' : '\n        ' + detail));
}
/** @param {string} msg @returns {never} */
function bail(msg) {
	console.error('\nENVIRONMENT: ' + msg);
	process.exit(2);
}
/** Two rendered pixel values agree if they are within half a device pixel of each other. */
const near = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ tol = 0.5) =>
	Math.abs(a - b) <= tol;
const px = (/** @type {string | null} */ v) => (v == null ? NaN : parseFloat(v));

/**
 * Everything a variant can be asked about the sheet, in ONE round trip so no measurement can be taken
 * against a different layout pass than its neighbour. `sel` is the sheet's own root element; both inner
 * selectors come from the contract, never spelled out here.
 * @param {Page} page
 * @param {string} sel
 */
async function readSheet(page, sel) {
	const q = (/** @type {string} */ s) => JSON.stringify(s);
	return await page.evaluate(`(() => {
		const sheet = document.querySelector(${q(sel)});
		if (!sheet) return null;
		const peek = sheet.querySelector(${q(SEL.peek)});
		const body = sheet.querySelector(${q(SEL.sheetBody)});
		const cs = getComputedStyle(sheet);
		const root = getComputedStyle(document.documentElement);
		const r = sheet.getBoundingClientRect();
		return {
			maxHeightPx: parseFloat(cs.maxHeight),
			renderedH: r.height,
			topY: r.top,
			bottomY: r.bottom,
			transform: cs.transform,
			transition: cs.transitionDuration + ' ' + cs.transitionProperty,
			peekPadBottom: peek ? parseFloat(getComputedStyle(peek).paddingBottom) : null,
			bodyPadBottom: body ? parseFloat(getComputedStyle(body).paddingBottom) : null,
			peekH: peek ? peek.getBoundingClientRect().height : null,
			// The token as the page actually resolves it, plus the inline write that may be beating the
			// media query. Reading both is the only way to state WHICH writer won.
			peekHToken: root.getPropertyValue('--peek-h').trim(),
			peekHInline: document.documentElement.style.getPropertyValue('--peek-h').trim(),
			innerHeight: window.innerHeight
		};
	})()`);
}

/** @param {Page} page @param {string} sel  Is the sheet's own bottom edge on screen? */
async function peekVisible(page, sel) {
	return await page.evaluate(`(() => {
		const el = document.querySelector(${JSON.stringify(sel)});
		if (!el) return null;
		const r = el.getBoundingClientRect();
		// the peek is "showing" when some of the sheet is inside the viewport at the bottom
		const visible = r.top < window.innerHeight && r.bottom > 0;
		return { visible, showingPx: Math.max(0, Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top)) };
	})()`);
}

async function main() {
	const chromium = findChromium();
	if (!chromium) bail('no Chromium found (playwright cache empty)');
	try {
		const res = await fetch(base + '/components');
		if (!res.ok)
			bail(`the gallery at ${base}/components answered ${res.status} — run \`bun run build\` and boot the server`);
	} catch {
		bail(`nothing is listening on ${base} — boot the server first (see the header)`);
	}
	mkdirSync(SHOTS, { recursive: true });

	const proc = spawn(
		chromium,
		[
			'--headless=new',
			'--no-sandbox',
			'--disable-gpu',
			'--hide-scrollbars',
			`--remote-debugging-port=${CDP_PORT}`,
			'--remote-allow-origins=*',
			'about:blank'
		],
		{ stdio: 'ignore' }
	);
	let browser;
	try {
		browser = await connect(CDP_PORT);
	} catch (err) {
		proc.kill();
		bail('could not attach to Chromium: ' + String(err));
	}

	/** Measure one variant end to end. @param {'incumbent'|'drawer'} variant */
	async function measure(variant) {
		const page = await browser.newPage();
		const url = base + '/components' + (variant === 'drawer' ? '?spike827=drawer' : '');
		// The sheet's own root differs by variant: the incumbent authors the element, the port gets it
		// from the library and can only tag it through a class prop. Both come from the contract.
		const sel = variant === 'drawer' ? SEL.spikeDrawer827 : SEL.sheet;
		const peekSel = `${sel} ${SEL.peek}`;

		await page.viewport(390, 844, 2);
		await page.safeAreaInsets({ top: 0, right: 0, bottom: INSET, left: 0 });
		await page.goto(url);
		await page.waitFor(`document.querySelector(${JSON.stringify(sel)}) !== null`, { timeout: 15000 });
		/*
		 * 1.5s, not 700ms, and the reason is a real property of the port rather than flake insurance.
		 * vaul's `shouldDrag` (`use-drawer-root.svelte.js:93`) returns FALSE for any gesture starting
		 * within 500ms of its own `openTime`, and latches that decision for the whole gesture — so a drag
		 * dispatched too soon after mount is silently ignored and looks exactly like "snap points do not
		 * work". Measured: at 700ms the port reported 20 drag events, 0 movement; at 1.5s the same drag
		 * lands the snap point. The incumbent has no such window, which is itself worth knowing.
		 */
		await sleep(1500); // let the peek measure itself, the --peek-h write land, and vaul's openTime lapse

		const collapsed = await readSheet(page, sel);
		const collapsedVis = await peekVisible(page, sel);
		await page.screenshot(join(SHOTS, `${variant}-collapsed-390x844.png`));

		/*
		 * THE GESTURE, with a real trusted pointer. "snapPoints is declared in types.d.ts" is a weaker
		 * claim than "a finger on the grip reaches the snap point", and only the second one is what the
		 * peek state depends on. Drag UP from inside the peek by 200px — past the incumbent's 48px commit
		 * threshold and past any plausible snap threshold — and read where the sheet ended up. The grab
		 * point is the grip's own row, a few px below the sheet's top edge.
		 */
		const grabY = Math.round(collapsed.topY + 20);
		await page.drag(195, grabY, 195, grabY - 200, { steps: 20, settle: 25 });
		await sleep(1200);
		const afterDrag = await readSheet(page, sel);
		// How many pointermove events the library actually received, so "it did not move" can be told
		// apart from "it never saw the gesture". Null on the incumbent, which has no such hook.
		const dragHook = await page.evaluate(`JSON.stringify(window.__spike827 ?? null)`);
		await page.screenshot(join(SHOTS, `${variant}-after-drag-up-390x844.png`));
		// put it back so the keyboard arm below starts from the same state
		if (afterDrag.topY < collapsed.topY - 4) {
			await page.pressKey(peekSel, 'ArrowDown');
			await sleep(900);
		}

		// Expand the way a keyboard user does. `.click()` on the peek does nothing on the incumbent (it
		// is a div with pointer handlers), which is exactly why cdp.mjs has pressKey.
		await page.pressKey(peekSel, 'ArrowUp');
		await sleep(900); // past the transition, whichever variant's duration it is
		const expanded = await readSheet(page, sel);
		await page.screenshot(join(SHOTS, `${variant}-expanded-390x844.png`));

		// The short-viewport arm: 480px tall is where `@media (max-height: 480px)` sets --peek-h: 84px,
		// and where the inline write's precedence over it is the whole finding.
		await page.viewport(390, 480, 2);
		await sleep(700);
		const short = await readSheet(page, sel);
		await page.screenshot(join(SHOTS, `${variant}-expanded-390x480.png`));

		// And with no inset at all, so the env() term can be reported as a DIFFERENCE rather than as a
		// number that happens to look right.
		await page.viewport(390, 844, 2);
		await page.safeAreaInsets({ top: 0, right: 0, bottom: 0, left: 0 });
		await sleep(500);
		const noInset = await readSheet(page, sel);

		return { collapsed, collapsedVis, expanded, short, noInset, afterDrag, dragHook };
	}

	const inc = await measure('incumbent');
	const drw = await measure('drawer');

	if (!inc.collapsed) bail('the incumbent QueueSheet never rendered in the gallery');
	if (!drw.collapsed) {
		console.log(
			'\nThe drawer variant never rendered — reporting that as the spike result, not as an environment fault.'
		);
		check('N0 · the port renders at all', false, 'no .spike-drawer element in the gallery at ?spike827=drawer');
	}

	const rows = [];
	/** @param {string} n @param {unknown} i @param {unknown} d */
	const row = (n, i, d) => rows.push({ number: n, incumbent: i, drawer: d });

	console.log('\n=== THE FOUR NUMBERS ============================================================\n');

	/*
	 * The other half of N4 — the `app.css` fallback and the `@media (max-height: 480px)` override — and a
	 * CORRECTION to how the issue states it. Both are invisible on any page with a mounted sheet, because
	 * the inline write always wins; and the 84px rule is not global at all. It lives in
	 * `routes/+page.svelte`'s own `<style>`, so it compiles into the PHONE ROUTE's stylesheet only: on
	 * /join at 480px tall the token measured 132px, not 84px. Its own comment says what it is for — a
	 * smaller fallback "still buys rows before that measurement lands" — so 84px is a PRE-MEASUREMENT
	 * value on one route, not a steady state.
	 *
	 * Measured deterministically rather than by racing hydration: read the token, then REMOVE the inline
	 * property and read again. The second read is what the cascade gives with the inline writer gone,
	 * which is exactly the precedence claim, and it needs no timing luck.
	 */
	const bare = await (async () => {
		const page = await browser.newPage();
		const read = () =>
			page.evaluate(
				`(() => ({
					token: getComputedStyle(document.documentElement).getPropertyValue('--peek-h').trim(),
					inline: document.documentElement.style.getPropertyValue('--peek-h').trim()
				}))()`
			);
		const dropInline = () => page.evaluate(`document.documentElement.style.removeProperty('--peek-h'), 1`);

		await page.viewport(390, 844, 2);
		await page.goto(base + '/');
		await sleep(1200);
		const tallWith = await read();
		await dropInline();
		const tallBare = await read();

		await page.viewport(390, 480, 2);
		await sleep(600);
		await dropInline(); // a re-render may have re-published it
		const shortBare = await read();

		// and the same short viewport on a route whose stylesheet does NOT carry the override
		await page.goto(base + '/join');
		await sleep(600);
		const joinShort = await read();
		return { tallWith, tallBare, shortBare, joinShort };
	})();
	row(
		'N4 --peek-h with the inline write REMOVED @844 / @480',
		`${bare.tallBare.token} / ${bare.shortBare.token}`,
		'(route-level tokens, variant-independent)'
	);
	row('N4 --peek-h on /join @480 (no override in that stylesheet)', bare.joinShort.token, '(same)');
	check(
		`N4 · with the inline writer gone, the app.css fallback stands: ${PEEK_H_FALLBACK}px @844`,
		px(bare.tallBare.token) === PEEK_H_FALLBACK,
		`token ${bare.tallBare.token} (inline was ${bare.tallWith.inline || '(none)'})`
	);
	check(
		`N4 · and the phone route's @media (max-height: 480px) override then gives ${PEEK_H_SHORT}px`,
		px(bare.shortBare.token) === PEEK_H_SHORT,
		`token ${bare.shortBare.token}`
	);
	check(
		`N4 · that override is ROUTE-SCOPED, not global — /join at 480 tall stays at ${PEEK_H_FALLBACK}px`,
		px(bare.joinShort.token) === PEEK_H_FALLBACK,
		`token ${bare.joinShort.token} — the issue states this override as if it were global`
	);

	// ---- N1 · max-height: 82dvh -------------------------------------------------------------------
	const incCap = inc.expanded.maxHeightPx;
	const drwCap = drw.expanded ? drw.expanded.maxHeightPx : NaN;
	const want844 = CAP_FRACTION * 844;
	row(
		'N1 max-height 82dvh @844',
		`${incCap}px (${(incCap / 844).toFixed(4)}dvh)`,
		Number.isNaN(drwCap) ? 'n/a' : `${drwCap}px (${(drwCap / 844).toFixed(4)}dvh)`
	);
	check(
		`N1 · incumbent caps at 82dvh = ${want844}px`,
		near(incCap, want844),
		`measured ${incCap}px, wanted ${want844}px`
	);
	check(`N1 · port caps at 82dvh = ${want844}px`, near(drwCap, want844), `measured ${drwCap}px, wanted ${want844}px`);
	// The cap only means something if it BINDS. A cap larger than the rendered height is dead weight,
	// and the port's height is set by the snap point rather than by this rule.
	row(
		'N1 rendered height when expanded',
		`${inc.expanded.renderedH.toFixed(2)}px`,
		drw.expanded ? `${drw.expanded.renderedH.toFixed(2)}px` : 'n/a'
	);

	// ---- N2 · .peek env(safe-area-inset-bottom) ----------------------------------------------------
	const incPeekPad = inc.collapsed.peekPadBottom;
	const incPeekPadNo = inc.noInset.peekPadBottom;
	const drwPeekPad = drw.collapsed ? drw.collapsed.peekPadBottom : NaN;
	const drwPeekPadNo = drw.noInset ? drw.noInset.peekPadBottom : NaN;
	row('N2 .peek padding-bottom (inset 34 / 0)', `${incPeekPad} / ${incPeekPadNo}`, `${drwPeekPad} / ${drwPeekPadNo}`);
	check(
		`N2 · incumbent .peek resolves calc(${PEEK_PAD_BASE}px + env(...)) — ${PEEK_PAD_BASE + INSET} with a ${INSET}px inset, ${PEEK_PAD_BASE} without`,
		near(incPeekPad, PEEK_PAD_BASE + INSET) && near(incPeekPadNo, PEEK_PAD_BASE),
		`measured ${incPeekPad} / ${incPeekPadNo}`
	);
	check(
		`N2 · port .peek resolves calc(${PEEK_PAD_BASE}px + env(...)) the same way`,
		near(drwPeekPad, PEEK_PAD_BASE + INSET) && near(drwPeekPadNo, PEEK_PAD_BASE),
		`measured ${drwPeekPad} / ${drwPeekPadNo}`
	);

	// ---- N3 · .body env(safe-area-inset-bottom) ----------------------------------------------------
	const incBodyPad = inc.expanded.bodyPadBottom;
	const incBodyPadNo = inc.noInset.bodyPadBottom;
	const drwBodyPad = drw.expanded ? drw.expanded.bodyPadBottom : NaN;
	const drwBodyPadNo = drw.noInset ? drw.noInset.bodyPadBottom : NaN;
	row('N3 .body padding-bottom (inset 34 / 0)', `${incBodyPad} / ${incBodyPadNo}`, `${drwBodyPad} / ${drwBodyPadNo}`);
	check(
		`N3 · incumbent .body resolves calc(${BODY_PAD_BASE}px + env(...)) — ${BODY_PAD_BASE + INSET} / ${BODY_PAD_BASE}`,
		near(incBodyPad, BODY_PAD_BASE + INSET) && near(incBodyPadNo, BODY_PAD_BASE),
		`measured ${incBodyPad} / ${incBodyPadNo}`
	);
	check(
		`N3 · port .body resolves calc(${BODY_PAD_BASE}px + env(...)) the same way`,
		near(drwBodyPad, BODY_PAD_BASE + INSET) && near(drwBodyPadNo, BODY_PAD_BASE),
		`measured ${drwBodyPad} / ${drwBodyPadNo}`
	);

	// ---- N4 · --peek-h 132px, the 84px short-viewport override, and who outranks whom --------------
	row(
		'N4 --peek-h resolved @844 (token / inline)',
		`${inc.collapsed.peekHToken} / ${inc.collapsed.peekHInline || '(none)'}`,
		drw.collapsed ? `${drw.collapsed.peekHToken} / ${drw.collapsed.peekHInline || '(none)'}` : 'n/a'
	);
	row(
		'N4 --peek-h resolved @480 (token / inline)',
		`${inc.short.peekHToken} / ${inc.short.peekHInline || '(none)'}`,
		drw.short ? `${drw.short.peekHToken} / ${drw.short.peekHInline || '(none)'}` : 'n/a'
	);
	row(
		'N4 measured peek height @844 / @480',
		`${inc.collapsed.peekH?.toFixed(2)} / ${inc.short.peekH?.toFixed(2)}`,
		drw.collapsed ? `${drw.collapsed.peekH?.toFixed(2)} / ${drw.short.peekH?.toFixed(2)}` : 'n/a'
	);
	// The fallback is what the token reads BEFORE any measurement — asserted from app.css rather than
	// re-measured, because a mounted sheet always overwrites it.
	check(
		`N4 · incumbent writes a measured --peek-h inline, and it is what the page resolves`,
		inc.collapsed.peekHInline !== '' && inc.collapsed.peekHToken === inc.collapsed.peekHInline,
		`token ${inc.collapsed.peekHToken}, inline ${inc.collapsed.peekHInline || '(none)'}`
	);
	check(
		`N4 · the inline write OUTRANKS @media (max-height: 480px) — @480 the token is the measured value, not ${PEEK_H_SHORT}px`,
		inc.short.peekHToken === inc.short.peekHInline && px(inc.short.peekHToken) !== PEEK_H_SHORT,
		`@480 token ${inc.short.peekHToken}, inline ${inc.short.peekHInline || '(none)'}, media rule would give ${PEEK_H_SHORT}px`
	);
	check(
		`N4 · port keeps the same --peek-h contract (writes it, and it resolves to the write)`,
		!!drw.collapsed && drw.collapsed.peekHInline !== '' && drw.collapsed.peekHToken === drw.collapsed.peekHInline,
		drw.collapsed
			? `token ${drw.collapsed.peekHToken}, inline ${drw.collapsed.peekHInline || '(none)'}`
			: 'the port never rendered'
	);
	check(
		`N4 · port's peek height matches the incumbent's within 1px (same content, same measurement)`,
		!!drw.collapsed && near(drw.collapsed.peekH ?? NaN, inc.collapsed.peekH ?? NaN, 1),
		drw.collapsed
			? `port ${drw.collapsed.peekH?.toFixed(2)}, incumbent ${inc.collapsed.peekH?.toFixed(2)}`
			: 'the port never rendered'
	);

	// ---- The GESTURE · a real trusted pointer drag up from the collapsed peek ----------------------
	// Risk 1 in the issue asks whether snap points are EXPOSED. Declared in `types.d.ts` is not the same
	// claim as reachable by a finger, and the peek state depends on the second one.
	const incDragRise = inc.collapsed.topY - inc.afterDrag.topY;
	const drwDragRise = drw.afterDrag && drw.collapsed ? drw.collapsed.topY - drw.afterDrag.topY : NaN;
	row(
		'gesture · sheet top rose by, on a 200px drag up',
		`${incDragRise.toFixed(2)}px`,
		Number.isNaN(drwDragRise) ? 'n/a' : `${drwDragRise.toFixed(2)}px`
	);
	check(
		'gesture · incumbent commits the pull past its 48px threshold',
		incDragRise > 48,
		`sheet top rose ${incDragRise.toFixed(2)}px (threshold COMMIT_PX = 48)`
	);
	check(
		'gesture · port reaches its expanded snap point on the same drag',
		Number.isNaN(drwDragRise) ? false : near(drw.afterDrag.topY, 844 - CAP_FRACTION * 844, 2),
		drw.afterDrag
			? `sheet top landed at ${drw.afterDrag.topY.toFixed(2)}px, the 0.82 snap is ${(844 - CAP_FRACTION * 844).toFixed(2)}px; vaul saw ${drw.dragHook ?? 'no'} drag events`
			: 'the port never rendered'
	);
	row('gesture · vaul drag callbacks observed', 'n/a (no hook)', drw.dragHook ?? 'none');

	// ---- The collapsed peek must be ON SCREEN. Not one of the four, but the state they describe. ----
	row(
		'peek showing when collapsed',
		`${inc.collapsedVis.showingPx.toFixed(2)}px`,
		drw.collapsedVis ? `${drw.collapsedVis.showingPx.toFixed(2)}px` : 'n/a'
	);
	check(
		'collapsed · incumbent leaves the peek on screen',
		inc.collapsedVis.showingPx > 0,
		`showing ${inc.collapsedVis.showingPx}px`
	);
	check(
		'collapsed · port leaves the peek on screen',
		!!drw.collapsedVis && drw.collapsedVis.showingPx > 0,
		drw.collapsedVis ? `showing ${drw.collapsedVis.showingPx}px` : 'the port never rendered'
	);

	// ---- Motion: same curve, and whose duration wins ----------------------------------------------
	row('transition (computed, expanded)', inc.expanded.transition, drw.expanded ? drw.expanded.transition : 'n/a');
	row('transform (computed, collapsed)', inc.collapsed.transform, drw.collapsed ? drw.collapsed.transform : 'n/a');

	console.log(
		'\n' +
			rows
				.map((r) => `  ${r.number.padEnd(44)} incumbent: ${String(r.incumbent).padEnd(34)} port: ${r.drawer}`)
				.join('\n')
	);
	console.log(`\n  screenshots: ${SHOTS}`);

	browser.close();
	proc.kill();

	const failed = checks.filter((c) => !c.ok);
	console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length) {
		console.log('failed:\n' + failed.map((f) => '  - ' + f.name).join('\n'));
		console.log('\nA failing check here is a SPIKE FINDING about the port, not necessarily a bug to fix.');
	}
	process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
