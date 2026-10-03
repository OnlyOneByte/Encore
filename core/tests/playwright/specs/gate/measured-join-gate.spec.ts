/*
 * CLAIM 7: the join gate lands in the SAME PLACE on both of its hosts, and that place is the one its own
 * component declares — CENTRED from --bp-md up, FILLED and bottom-docked below it.
 *
 * IT HAS TWO HOSTS, which is what made them disagree: `/` renders `<JoinLanding />` inside the home route's
 * `main` (src/routes/+page.svelte), `/library` renders it as a direct child of `.app-shell` with no `main` at
 * all (src/routes/library/+page.svelte). The host's own `main { flex: 1 }` absorbed the free space that
 * `.app-shell:has(.join-main) { justify-content: center }` wanted to distribute, so the >=768 centring worked
 * on `/library` and silently did nothing on `/`. The fix is a cascade/`:has()`/specificity stack in
 * JoinLanding's own stylesheet — the route may not state the gate's placement — and that is the most fragile
 * kind of fix in this codebase: it depends on `:global(.app-shell > main:has(.join-main))` scoring 0,2,1 so it
 * beats the route's scoped `main` rule at 0,1,1, whose chunk loads LATER and would otherwise win the tie.
 *
 * WHY IT IS A GATE AND NO LONGER A PROBE. This lived at specs/probe/join-gate-placement.spec.ts, and gate leg
 * 7 is `playwright test --project=gate`, so the check on the most regression-prone fix in the tree never ran in
 * `bun run gates`. Its own header said so honestly, which did not make it run. Promoted whole rather than
 * copied: there is one placement assertion in this suite, and it is this file.
 *
 * WHAT IT ADDS TO WHAT THE PROBE ASSERTED. The probe held three DELTAS at zero. Equality alone cannot fail on
 * a tree where BOTH hosts break the same way — delete `justify-content: center` and the two routes agree
 * perfectly on a top-aligned gate — so the absolute half is asserted too: from --bp-md up the free space above
 * the gate equals the free space below it ON EACH HOST, below it the gate starts at the shell's content top and
 * the CTA docks. Two premises are asserted rather than assumed: that the hosts are still DIFFERENT (an
 * equality between two identical hosts measures nothing), and that the host `main` is really being neutralised
 * (`display: flex`, no route padding, `flex-grow` 0 at >=--bp-md and 1 below) — which is the declaration that
 * regressed, so naming it turns "head left 164 vs 148" into "the route's padding is back".
 *
 * ONE TEST, because two of its arms are CROSS-VIEWPORT: the gate must be centred at --bp-md and NOT centred one
 * pixel below it, and no single-width reading can see that. Every arm is SOFT, so one run reports every broken
 * arm.
 *
 * VERIFIED BY REVERTING THE FIX — four reverts, each rebuilt and re-run, because a gate that passes on a broken
 * tree is worse than no gate:
 *   drop `flex: 0 0 auto` from the >=768 arm      15 arms red; head top 0 on `/` against 262.58 on `/library`,
 *                                                  read at 1024x900
 *   drop `justify-content: center`                12 arms red, and ONLY the absolute ones — every delta stayed 0
 *                                                  while at 1024x900 BOTH hosts read 0px above the brand band and
 *                                                  525.17px below the column, which is the hole this file closes
 *   make `flex: 0 0 auto` unconditional            8 arms red; the CTA undocks to y=353.05 of 844 at 390x844
 *   drop the whole neutralising rule              29 arms red; the mechanism arm names it — the host resolves
 *                                                  `display: block`/`grid` with `padding: 6px 16px 28px` back
 *
 * WHAT IS STILL NOT GATE-ABLE, and stays a note rather than becoming a weak assertion: `.submit-slot` is
 * `position: sticky` as well as auto-margined, and the case that needs the sticky offset is the on-screen
 * keyboard shrinking the LAYOUT viewport (`app.html`'s interactive-widget mode). Headless Chromium has no soft
 * keyboard, so no measured gate can drive that state — recorded already in docs/FRONTEND.md#the-join-screen and
 * in the rule's own comment. This gate measures the resting placement, which is the half a layout engine can
 * answer for.
 */
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { FLOORS } from './measured-design-register';
import type { BrowserContext } from '@playwright/test';

/** The two hosts, by route. The gate is the UNJOINED state, so neither needs a session. */
const HOSTS = ['/', '/library'] as const;

interface Placement {
	route: string;
	/** `null` on `/library`, which has no `main` — the difference that makes the equality worth measuring. */
	host: { display: string; padding: string; flexGrow: string } | null;
	/** The shell's CONTENT box, so a device reporting real safe-area insets is measured against the right edges. */
	contentTop: number;
	contentBottom: number;
	headTop: number;
	headLeft: number;
	columnBottom: number;
	/** `.join-main`'s own bottom inset — what "the CTA is docked to the bottom of the column" means in px. */
	columnPadBottom: number;
	ctaBottom: number;
	innerHeight: number;
	/** Read off `:root`, so the breakpoint this gate drives is the token and not a second copy of 768. */
	bpMd: number;
}

async function readPlacement(ctx: BrowserContext, baseURL: string, route: string): Promise<Placement> {
	// A PAGE PER ROUTE, and a fresh one: the defect was decided by which CSS chunk loaded last, so a second
	// route measured in the first one's document would be measured against the first one's chunk order.
	const page = await ctx.newPage();
	await page.goto(baseURL + route);
	await page.locator(SEL.joinHead).waitFor();
	const reading = await page.evaluate(
		({ appShell, mainColumn, joinHead, joinColumn, joinCta }) => {
			const box = (sel: string) => {
				const el = document.querySelector(sel);
				if (!el) throw new Error(`the join gate is missing ${sel} — its placement is UNMEASURED, not passed`);
				return el.getBoundingClientRect();
			};
			const shell = document.querySelector(appShell);
			if (!shell) throw new Error(`no ${appShell} on this route — there is no shell to place the gate in`);
			const scs = getComputedStyle(shell);
			const sb = shell.getBoundingClientRect();
			const host = shell.querySelector(`:scope > ${mainColumn}`);
			const columnEl = document.querySelector(joinColumn);
			if (!columnEl) throw new Error(`the join gate is missing ${joinColumn} — its placement is UNMEASURED`);
			return {
				host: host
					? {
							display: getComputedStyle(host).display,
							padding: getComputedStyle(host).padding,
							flexGrow: getComputedStyle(host).flexGrow
						}
					: null,
				contentTop: sb.top + parseFloat(scs.paddingTop),
				contentBottom: sb.bottom - parseFloat(scs.paddingBottom),
				headTop: box(joinHead).top,
				headLeft: box(joinHead).left,
				columnBottom: columnEl.getBoundingClientRect().bottom,
				columnPadBottom: parseFloat(getComputedStyle(columnEl).paddingBottom),
				ctaBottom: box(joinCta).bottom,
				innerHeight: window.innerHeight,
				bpMd: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bp-md'))
			};
		},
		{
			appShell: SEL.appShell,
			mainColumn: SEL.mainColumn,
			joinHead: SEL.joinHead,
			joinColumn: SEL.joinColumn,
			joinCta: SEL.joinCta
		}
	);
	await page.close();
	return { route, ...reading };
}

/*
 * FIVE VIEWPORTS, and the middle two are the point: 767 and 768 straddle --bp-md, so the arm's `768` literal in
 * JoinLanding.svelte is held against the `--bp-md` token BY BEHAVIOUR — the centring has to switch on across
 * exactly that one pixel. app.css says of the --bp-* list that "nothing READS these tokens", because an
 * @media condition is evaluated before the cascade and cannot resolve a custom property; this gate reads the
 * token off `:root` and drives its two sides, which is the one place in the tree where a media literal and its
 * token are checked against each other.
 *
 * 390x844 is the phone the whole app is measured on; 1024x900 is where the divergence was first measured (a
 * 257px head-top split); 1920x1080 is the gate project's own viewport. Every CENTRED arm is also a check that
 * the neutralising rule beats a `display` the route sets: from --bp-md up `/`'s own `main` rule makes it a
 * `display: grid`, and with the neutraliser deleted the host resolves `grid` at 768, 1024 and 1920 — measured.
 * `centred` is what the placement rule PROMISES at that width, not an observation: each arm asserts it.
 */
const ARMS: { width: number; height: number; centred: boolean }[] = [
	{ width: 390, height: 844, centred: false },
	{ width: 767, height: 900, centred: false },
	{ width: 768, height: 900, centred: true },
	{ width: 1024, height: 900, centred: true },
	{ width: 1920, height: 1080, centred: true }
];

test('CLAIM 7 the join gate lands identically on / and /library, centred from --bp-md up and docked below it', async ({
	browser,
	world
}) => {
	const readings: Placement[] = [];

	for (const vp of ARMS) {
		const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
		const seen: Placement[] = [];
		for (const route of HOSTS) seen.push(await readPlacement(ctx, world.baseURL, route));
		readings.push(...seen);
		await ctx.close();
		const [home, lib] = seen as [Placement, Placement];
		const at = `${vp.width}x${vp.height}`;

		/*
		 * THE THREE DELTAS. 1px, not 0: the centred position is a SUB-PIXEL value at these heights — both hosts read
		 * a head top of 262.58 at 768x900 and at 1024x900, and 352.58 at 1920x1080 — and the claim is that both
		 * routes land on the SAME subpixel rather than on a round number.
		 */
		expect
			.soft(
				Math.abs(home.headTop - lib.headTop),
				`CLAIM 7 at ${at} the gate's brand band starts at the same height on both hosts: ` +
					`head top ${home.headTop.toFixed(2)} on / against ${lib.headTop.toFixed(2)} on /library`
			)
			.toBeLessThanOrEqual(1);
		expect
			.soft(
				Math.abs(home.headLeft - lib.headLeft),
				`CLAIM 7 at ${at} the gate sits on the app's ONE gutter on both hosts — no second inline inset from a ` +
					`route: head left ${home.headLeft.toFixed(2)} on / against ${lib.headLeft.toFixed(2)} on /library`
			)
			.toBeLessThanOrEqual(1);
		expect
			.soft(
				Math.abs(home.ctaBottom - lib.ctaBottom),
				`CLAIM 7 at ${at} the CTA's bottom edge lands identically on both hosts: ` +
					`${home.ctaBottom.toFixed(2)} on / against ${lib.ctaBottom.toFixed(2)} on /library`
			)
			.toBeLessThanOrEqual(1);

		// THE PREMISE OF ALL THREE: two hosts that had become the same host would satisfy every equality above
		// while measuring nothing. `/` must still wrap the gate in a `main`; `/library` must still not have one.
		expect
			.soft(
				`${home.host ? 'main' : 'none'} / ${lib.host ? 'main' : 'none'}`,
				`CLAIM 7 at ${at} the two hosts are still DIFFERENT, which is what makes the equalities above mean ` +
					`something: the gate must be inside ${SEL.appShell} > ${SEL.mainColumn} on / and a direct child of ` +
					`${SEL.appShell} on /library`
			)
			.toBe('main / none');

		// AND THE MECHANISM, because the geometry alone cannot say WHY it moved. These three are what
		// `:global(.app-shell > main:has(.join-main))` declares; a route chunk winning the cascade back shows up
		// here first, with the reason on it.
		if (home.host) {
			expect
				.soft(
					`${home.host.display} ${home.host.padding} ${home.host.flexGrow}`,
					`CLAIM 7 at ${at} the home route's host is NEUTRALISED — a flex column, no route padding, and ` +
						`${vp.centred ? 'no growth so the centring has free space to distribute' : 'growing so the column has a bottom for the CTA to reach'}: ` +
						`resolved display ${home.host.display}, padding ${home.host.padding}, flex-grow ${home.host.flexGrow} ` +
						'(the route declares `flex: 1` and `6px 16px calc(var(--dock-h, 0px) + 28px)`, so any of those reappearing is the route winning the cascade)'
				)
				.toBe(`flex 0px ${vp.centred ? '0' : '1'}`);
		}

		// THE ABSOLUTE HALF, per host: where the gate actually sits. Equality is blind to a break both hosts share.
		for (const p of [home, lib]) {
			const above = p.headTop - p.contentTop;
			const below = p.contentBottom - p.columnBottom;
			if (vp.centred) {
				expect
					.soft(
						Math.abs(above - below),
						`CLAIM 7 at ${at} the gate is really CENTRED on ${p.route} — free space split evenly, not merely ` +
							`agreed on: ${above.toFixed(2)}px above the brand band against ${below.toFixed(2)}px below the column`
					)
					.toBeLessThanOrEqual(1);
				// A centring that distributes nothing is satisfied by a column that happens to fill the shell, which
				// is exactly the broken state on `/` — so the free space has to be REAL at these widths.
				expect
					.soft(
						above,
						`CLAIM 7 at ${at} there is free space for the centring to distribute on ${p.route}, so the arm above ` +
							`is not satisfied by a full column: ${above.toFixed(2)}px above the brand band`
					)
					.toBeGreaterThan(1);
			} else {
				expect
					.soft(
						above,
						`CLAIM 7 at ${at} the gate FILLS its host below --bp-md (${p.bpMd}px) on ${p.route} — the brand band ` +
							`starts at the shell's content top, it is not centred: ${above.toFixed(2)}px above it`
					)
					.toBeLessThanOrEqual(1);
				// DOCKED, by the column's own inset rather than by a number written here: `.join-main` keeps its
				// `--space-2xl` bottom padding below the arm (0 above it), so "docked" is the CTA sitting exactly that
				// far off the shell's content floor — 828 of 844 at 390x844, 884 of 900 at 767x900.
				expect
					.soft(
						Math.abs(p.contentBottom - p.ctaBottom - p.columnPadBottom),
						`CLAIM 7 at ${at} the CTA is docked to the bottom of the column on ${p.route}: its bottom edge is ` +
							`${(p.contentBottom - p.ctaBottom).toFixed(2)}px off the shell's content floor against the column's own ` +
							`${p.columnPadBottom}px bottom inset`
					)
					.toBeLessThanOrEqual(1);
				// THE CRITERION behind the docking, and the one a user feels: the app's first button is reachable
				// without a regrip. Same thumb-zone line CLAIM 3 holds the transport to.
				expect
					.soft(
						p.ctaBottom,
						`CLAIM 7 at ${at} the CTA is in the thumb zone on ${p.route} — the bottom third of the viewport: ` +
							`its bottom edge is at y=${p.ctaBottom.toFixed(2)} of ${p.innerHeight}px, and the zone starts at ` +
							`${((p.innerHeight * 2) / 3).toFixed(1)}`
					)
					.toBeGreaterThan((p.innerHeight * 2) / 3);
			}
		}
	}

	// THE BREAKPOINT THIS GATE DROVE, checked against the token every reading resolved off `:root`: an arm list
	// that stopped straddling --bp-md would assert the centring switch nowhere, and both halves of the claim
	// would then be measured on one side of it.
	const bpMd = readings[0].bpMd;
	// A REAL NUMBER, said out loud: a deleted or mistyped token makes this NaN, and every comparison below then
	// reads false-y without failing an arm of its own.
	expect
		.soft(
			Number.isFinite(bpMd) && bpMd > 0,
			`CLAIM 7 --bp-md resolves to a real px value off :root, so the arms can straddle it: read "${bpMd}"`
		)
		.toBe(true);
	expect
		.soft(
			readings.every((p) => p.bpMd === bpMd),
			`CLAIM 7 every route resolves the SAME --bp-md: ${[...new Set(readings.map((p) => p.bpMd))].join(', ')}`
		)
		.toBe(true);
	expect
		.soft(
			ARMS.filter((a) => a.centred).every((a) => a.width >= bpMd) &&
				ARMS.filter((a) => !a.centred).every((a) => a.width < bpMd) &&
				ARMS.some((a) => a.width === bpMd) &&
				ARMS.some((a) => a.width === bpMd - 1),
			`CLAIM 7 the arms straddle --bp-md (${bpMd}px) and sit one pixel either side of it, so the media literal in ` +
				`JoinLanding.svelte is held against the token: widths ${ARMS.map((a) => `${a.width}${a.centred ? ' centred' : ' filled'}`).join(', ')}`
		)
		.toBe(true);

	// NON-VACUITY, two ways: the EXACT count against the list actually driven (a dropped viewport or a dropped
	// host reds here, where the per-arm messages above would simply stop being printed), and the written-down
	// floor in the register, which is what a reader of FLOORS is owed.
	expect
		.soft(readings.length, `CLAIM 7 read both hosts at every one of the ${ARMS.length} arms`)
		.toBe(ARMS.length * HOSTS.length);
	expect
		.soft(
			readings.length,
			`CLAIM 7 measured real placements — >=${FLOORS.joinPlacementsMeasured}, so a drive that reached one host ` +
				'cannot report every equality satisfied against nothing'
		)
		.toBeGreaterThanOrEqual(FLOORS.joinPlacementsMeasured);
});
