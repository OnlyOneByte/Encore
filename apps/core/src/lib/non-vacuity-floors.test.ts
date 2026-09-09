/*
 * guard: the non-vacuity floors themselves (issue #830 — XR-VER-05, XR-VER-06, XR-VER-07).
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────────────────────
 *
 * Roughly two dozen guards in this repo derive their own scope at run time — they walk a tree, filter a
 * file list, or count the rules they matched. Every one of them then asserts an `offenders` array is
 * EMPTY. An empty array is what a working guard produces AND what a guard examining nothing produces,
 * so a scope regression (a moved directory, a renamed extension, a copy-in path outside the walk, a
 * component library that relocates markup) turns those guards GREEN rather than red.
 *
 * The repo's answer is a NON-VACUITY FLOOR: an assertion on the SIZE of what was actually examined.
 * `/metrics` (issue #140) and `lib/charts` both escaped hand-listed `FILES` arrays exactly this way, and
 * the floors were planted afterwards, one guard at a time.
 *
 * Which leaves one hole, and it is the hole this file closes:
 *
 *   > A FLOOR IS ITSELF A GUARD, AND NOTHING GUARDED THE FLOORS.
 *
 * A floor can be lowered, deleted, or quietly left off a newly-added scan, and no test notices. The
 * upcoming design-library migration makes that acute, because the migration's EXPECTED signal is these
 * floors firing — and a firing floor reads, to anyone who has not been told otherwise, as "the guard is
 * broken, lower the number". That reading converts a DETECTED loss of enforcement into a SILENT one,
 * which is worse than never having planted the floor.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
 * │  A FIRING NON-VACUITY FLOOR IS A FINDING, NEVER A NUMBER TO ADJUST.                              │
 * │                                                                                                  │
 * │  It does not mean the guard broke. It means the guard can no longer see the surface it was        │
 * │  enforcing on. The number is the messenger.                                                      │
 * │                                                                                                  │
 * │  If you are here because this file went red, the ONLY accepted resolutions are:                   │
 * │                                                                                                  │
 * │   (a) RESTORE THE SCOPE. The walk lost sight of files it should still see — fix the walk. This is │
 * │       the common case and it is a real defect the floor just caught for you.                      │
 * │                                                                                                  │
 * │   (b) RE-ANCHOR. The surface genuinely moved and the guard should follow it. Point the scan at    │
 * │       the new location and keep the floor at a value the new scope supports.                      │
 * │                                                                                                  │
 * │   (c) RETIRE, ON THE RECORD. The invariant genuinely stopped applying. Move the floor's entry     │
 * │       from FLOORS into RETIRED below with a written reason naming (1) the invariant whose scope    │
 * │       shrank, (2) the sites that left scope, and (3) the guard that now covers them, or an        │
 * │       explicit statement that none does. RETIRED is checked: the reason must be substantive and   │
 * │       the assertion must be genuinely GONE, so "retire" cannot be used to launder a lowered       │
 * │       number.                                                                                    │
 * │                                                                                                  │
 * │  Editing the literal in FLOORS downward to match a shrunken scope is NOT on that list. It is the  │
 * │  one action this file exists to make impossible to do quietly.                                    │
 * └──────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ── WHY A SNAPSHOT AND NOT AN EXTRACTOR ────────────────────────────────────────────────────────────
 *
 * A regex that harvests every `toBeGreaterThan` in the suite would also harvest assertions that are not
 * floors at all (`caps.length > 0`, `ratio >= 4.5`), so its own contents would drift and it could not
 * distinguish a deleted floor from an unrelated refactor. The floors are LITERALS, which is precisely
 * what makes a checked-in snapshot decidable: each entry names the file, the subject expression, and the
 * minimum, and the check is that an assertion at least that strong is still there.
 *
 * The snapshot is keyed by subject text, NOT by line number, so ordinary edits above a floor do not
 * churn this file — only a floor's disappearance or weakening does. `count` is a MINIMUM occurrence
 * count, so a sibling PR adding a new floor to a listed file is fine; removing one is not.
 */
import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..', '..');

type Floor = {
	/** the exact expression inside `expect(…)`, verbatim from the source */
	subject: string;
	/** the weakest literal accepted; a smaller one in source is a LOWERED floor and reds */
	min: number;
	/** how many assertions on this subject must be at least `min` (minimum, not exact) */
	count: number;
	/** what this floor is protecting, in one line, for the reviewer who meets its red */
	guards: string;
};

/**
 * Every non-vacuity floor in the suite, by file.
 *
 * The 18 that already existed when this file landed, plus the four added by issue #830: the two
 * enumerating walks that carried none (`chromium.test.ts`, `page-header.test.ts` — the XR-VER-05 gap),
 * and the two on the motion guard's new utility-class arm.
 */
const FLOORS: Record<string, Floor[]> = {
	'apps/core/src/lib/tailwind-toolchain.test.ts': [
		{
			subject: 'mintSurfaces',
			min: 1,
			count: 1,
			guards:
				'the surfaces the XR-COL-14 colour ban examines (#859) — every app.css `@theme` block plus every tailwind.config.* in the tree. The arm reports an empty offenders array both when the tree is clean AND when it scanned nothing (Tailwind uninstalled, the @theme regex stopped matching, the config walk lost its root), so this counts what was actually seen. Its firing means the rule went UNENFORCEABLE, which XR-VER-06 requires be loud rather than a vacuous pass.'
		}
	],
	'apps/core/src/lib/task-number-hygiene.test.ts': [
		{
			subject: 'files.length',
			min: 50,
			count: 2,
			guards:
				'the repo-wide task-number walk; an unanchored `git ls-files` returning nothing passed with zero files scanned'
		}
	],
	'apps/core/src/lib/drawer-surface-removed-903.test.ts': [
		{
			subject: 'scanned',
			min: 100,
			count: 1,
			guards:
				'the production-file walk behind the #903 deletion guard. The scan proves no live code imports the deleted drawer components, reads the retired --peek-h / --z-sheet tiers, or declares the sheet chrome — and it reports an empty offenders array both when the tree is genuinely clean AND when it read nothing (a wrong root, a broken extension filter, a test-file exclusion that swallowed the walk), so this counts what was actually opened. It REPLACES the `scanned` floor retired from design-system.test.ts in the same change: one population-counting floor out, one in'
		}
	],
	'apps/core/src/lib/icon-centring.test.ts': [
		{ subject: 'FILES.length', min: 7, count: 1, guards: 'the icon-centring components + routes walk' }
	],
	'apps/core/src/lib/contrast.test.ts': [
		{
			subject: 'rootsScanned',
			min: 3,
			count: 1,
			guards: 'card-root discovery; renaming the `card list-row` pair would find nothing'
		}
	],
	'apps/core/src/lib/singer-color.test.ts': [
		{
			subject: 'FILES.length',
			min: 15,
			count: 1,
			guards: 'the singer-colour svelte walk (two offender scans depend on it)'
		}
	],
	'apps/core/src/lib/touch-targets.test.ts': [
		{
			subject: 'controlRulesSeen',
			min: 10,
			count: 1,
			guards: 'control-rule derivation from markup; an empty tag/class set measured nothing'
		},
		{
			subject: 'FILES.length',
			min: 12,
			count: 1,
			guards:
				'the scanned POPULATION, added by #841 and RE-ANCHORED by #831. FILES is a walk over lib/components AND lib/ui plus five hand-named route pages, so a walk contributing nothing still leaves five files \u2014 and five files carry enough control rules that `controlRulesSeen` above stays green (measured). The two floors fail on different regressions. Raised 10\u219212 because lib/ui/ joined the walk: re-anchoring, not a lowered number.'
		},
		{
			subject: 'boxRulesSeen',
			min: 10,
			count: 1,
			guards:
				'the population of the EXPRESSION arm (#831, XR-PH-01), which filters harder than the value arm above \u2014 control rules that declare a width/height, not merely a box. A derivation that stopped finding box rules would report zero bare-literal offenders and pass, which is the exact vacuity that let 15 hand-written `44px` declarations sit under a green value guard.'
		}
	],
	'apps/core/src/lib/components/motion.test.ts': [
		{
			subject: 'files.length',
			min: 24,
			count: 3,
			guards: 'the .svelte + .css style walk shared by the layout-transition, keyframes and reduce-motion tests'
		},
		{ subject: 'svelte.length', min: 20, count: 1, guards: 'the markup walk behind the utility-class arm' },
		{ subject: 'netFiles.length', min: 40, count: 1, guards: 'the svelte + .ts walk behind the utility-name net' }
	],
	'apps/core/src/lib/design-system.test.ts': [
		{ subject: 'FILES.length', min: 15, count: 1, guards: 'the design-system source walk' },
		{ subject: 'seen', min: 2, count: 1, guards: 'the rules examined by the token-duplication scan' },
		{ subject: 'checked', min: 3, count: 1, guards: 'the surfaces examined by the surface-token scan' },
		{
			subject: 'bridgeRefsScanned',
			min: 200,
			count: 1,
			guards:
				'the var() population behind the @theme-only reference ban (#829). A @theme key emits no custom property, so a component naming one paints nothing; a regex slip here would report zero offences from zero readings'
		},
		{
			subject: 'forwardsChecked',
			min: 30,
			count: 1,
			guards:
				'the bridge entries whose right-hand side is resolved (#829) — catches an entry forwarding to itself, or to a :root token that does not exist. Reading no values would pass both silently'
		},
		{
			subject: 'spacingDeclsSeen',
			min: 200,
			count: 1,
			guards:
				'the gap/margin/padding declarations examined by the spacing-scale duplication scan (#829). Every offence it can report comes from this walk'
		},
		{
			subject: 'fontDeclsSeen',
			min: 60,
			count: 1,
			guards: 'the font-size declarations examined by the phone type-ladder duplication scan (#829)'
		},
		{
			subject: 'leadingDeclsSeen',
			min: 8,
			count: 1,
			guards:
				'the line-height declarations examined by the leading-scale duplication scan (#829). Deliberately the lowest floor here — the tree carries only ~15, which is why the dimension drifted unnoticed'
		},
		{
			subject: 'motionDeclsSeen',
			min: 10,
			count: 1,
			guards: 'the transition/animation declarations examined by the motion-scale duplication scan (#829)'
		},
		{
			subject: 'zDeclsSeen',
			min: 15,
			count: 1,
			guards:
				'the z-index declarations examined by the bare-integer ban (#829). Unlike its four siblings that rule is a TOTAL ban, so an empty walk would report a fully compliant tree'
		},
		{
			subject: 'TV.length',
			min: 5,
			count: 1,
			guards:
				'the TV file population behind the phone-ladder ban (#829). Tokenisation made `font-size: var(--ph-text-2xs)` an idiomatic green way to write a 10.88px font on a wall, invisible to the ten-foot floor in tv/stage-scale.test.ts; an empty TV walk would report a compliant stage'
		},
		{
			subject: 'rungsChecked',
			min: 10,
			count: 1,
			guards:
				'the adjacent-tier comparisons behind the ladder-ordering assertion (#829). This is what still pins #424/#473 — their guards used to assert the literals 7/8/10 and now assert tier NAMES, so the order itself is only checked here. LOWERED 11 -> 10 by #903, loudly and on the record (XR-VER-06): the INVARIANT is unchanged, the POPULATION shrank. --z-sheet-scrim (9) and --z-sheet (10) were the queue sheet\u2019s two tiers, and the drawer surface that was their only reader was deleted, so the phone ladder went from five tiers (four rungs) to three (two rungs) while TV\u2019s eight rungs are untouched. Nothing became unenforced: the sibling `unplaced` assertion still proves NO z-* token escapes a ladder, so a re-added sheet tier reds there rather than joining un-ordered'
		},
		{
			subject: 'literalsFound',
			min: 7,
			count: 1,
			guards:
				'the @media width-literal walk behind the breakpoint-membership guard (#852). The scan derives its scope by walking apps/*/src + packages/*/src, so an emptied walk would report zero non-member widths from zero readings — seven `@media` width queries exist today'
		}
	],
	'apps/core/src/lib/tv/stage-scale.test.ts': [
		{ subject: 'heroBadgesSeen', min: 2, count: 1, guards: 'hero-badge discovery on the TV stage' }
	],
	'apps/core/src/lib/ui/icons.test.ts': [
		{ subject: 'FILES.length', min: 15, count: 1, guards: 'the icon svelte walk' },
		{ subject: "tsFiles(join(SRC, 'lib')).length", min: 10, count: 1, guards: 'the icon .ts walk' }
	],
	'apps/core/e2e/contract.test.ts': [
		{ subject: 'DRIVERS.length', min: 20, count: 1, guards: 'e2e driver discovery for the selector contract' },
		{ subject: 'lits.length', min: 19, count: 1, guards: 'the selector literals the contract scan collected' },
		{
			subject: 'sources.length',
			min: 20,
			count: 1,
			guards:
				'the .svelte walk the SEL-resolution guard resolves against, added by #841. The two floors beside it pin the DRIVER list and the collected literals, not the source population, so a narrowed walk whose surviving files still carry every SEL anchor left whole surfaces unexamined and every floor green.'
		}
	],
	// added by issue #830 — both walks previously had NO floor, and both feed tests that assert an
	// offenders array is empty, so an emptied walk passed while examining nothing.
	'apps/core/e2e/lib/chromium.test.ts': [
		{
			subject: 'out.length',
			min: 20,
			count: 1,
			guards: 'the e2e .mjs driver walk behind the findChromium single-source ban'
		}
	],
	'apps/core/src/lib/ui/page-header.test.ts': [
		{
			subject: 'out.length',
			min: 7,
			count: 1,
			guards: 'the route-page walk behind the h1-landmark and back-affordance rules'
		}
	],
	'apps/core/src/lib/phone-inventory.test.ts': [
		{
			subject: 'PHONE_ROUTES.length',
			min: 4,
			count: 1,
			guards:
				'the filesystem-derived phone route set behind the XR-PH-08 state inventory; an over-broad exemption match or a moved routes/ dir would enumerate nothing and pass'
		},
		{
			subject: 'filesScanned',
			min: 10,
			count: 2,
			guards:
				'the phone style-file walk behind the XR-PH-02 absolute-font-size floor and the XR-PH-03 inline-opacity ban'
		},
		{
			subject: 'declarationsSeen',
			min: 10,
			count: 1,
			guards:
				'the width-declaration scan behind the XR-PH-02 320px reflow floor; a regex that matches no declarations reports zero offenders'
		}
	]
};

/**
 * Floors deliberately retired, with the reason. EMPTY TODAY — nothing has been retired yet.
 *
 * This is the ONLY sanctioned way for an entry to leave FLOORS. The checks below make it a real record
 * rather than an escape hatch: the reason must be substantive, and the assertion must be genuinely
 * absent from the file, so an entry cannot be parked here while a weakened version of the same floor
 * stays in the source.
 */
const RETIRED: Record<string, { subject: string; reason: string }[]> = {
	'apps/core/src/lib/design-system.test.ts': [
		{
			subject: 'scanned',
			reason:
				'RETIRED BY #903 with the guard it floored: `a keydown handler that preventDefault()s on a snippet host early-returns on foreign targets (#301)`. XR-VER-06 record. (a) The invariant: an inline-arrow onkeydown that cancels the event must early-return on `e.target !== e.currentTarget`, so a key pressed on a child control is not swallowed by its host. (b) What left scope: its ENTIRE population. QueueSheet.svelte and QueueSheetDrawer.svelte were measured to be the only two files under apps/core/src matching an inline-arrow onkeydown that calls preventDefault(, and both were deleted with the drawer surface — so the scan would have examined 0 files and this floor (>= 1) would have fired every run. (c) What covers it now: NOTHING, because there is nothing left to cover — no surviving surface has a preventDefault-ing inline keydown host. The floor was doing its job by firing; it is retired rather than lowered to 0, which is what "never leave a guard passing vacuously" requires. If such a host reappears, restore the guard AND this floor together rather than reviving one alone.'
		},
		{
			subject: 'the dvh sheet-cap scan (every bottom-docked sheet caps its height in dvh, not vh)',
			reason:
				'RETIRED BY #903. The guard looped over a hardcoded list of exactly two files — QueueSheet.svelte and QueueSheetDrawer.svelte — asserting each declared a max-height in dvh/svh and none in vh (iOS resolves vh against the LARGE viewport, so a vh-capped sheet hides its own footer while the URL bar shows). Both files were deleted, so the list is empty and there is NO successor address: the only viewport-unit cap left under apps/core/src is lib/tv/TvLobby.svelte\u2019s `max-height: 20vh`, a TV surface, in vh — re-pointing there would INVERT the assertion into a failure. Its PENDING_RULING said RE-ANCHOR, DO NOT DELETE, and that ruling was correct for what it anticipated: a PORT, where the sheet still existed at a new address. This is a REMOVAL, so there is no address to move to and nothing is being laundered away — no surface docked to the bottom caps itself in a viewport fraction any more. SHEET_CAP_FRACTION was retired from the measured-design register in the same commit for the same reason.'
		}
	],
	'apps/core/src/lib/phone-reflow-rung-l.test.ts': [
		{
			subject: 'the sheet-level reflow floor (.sheet-surface > * min-width: 0, #857)',
			reason:
				'RETIRED BY #903. XR-VER-06 record. (a) The invariant: a `left:0; right:0` fixed box only honours min(max-width, viewport) while its flex children CAN shrink to it, because a flex child\u2019s automatic minimum is its min-content width — an unbreakable control label at 200% text sized the sheet by content it could not shrink below (436px inside a 320px viewport, SC 1.4.10 Reflow). (b) What left scope: `.sheet-surface` and its children, the only box the rule ever dressed, deleted with the drawer surface. (c) What covers the survivors: nothing asserts this on the docked band, DELIBERATELY. `.cta-dock` / `.search-dock` are a flex row holding ONE 44px control rather than a column of unbreakable labels, and neither declares min-width: 0 — so re-pointing the scan at them would assert a declaration that does not exist and demand production CSS for a defect nobody has measured. The band\u2019s reflow is covered where it is real: the rung-L probe arms measure the live pages at 320 CSS px and 200% text and FAIL on overflow. If a future band grows a multi-control column, add a floor for that band rather than reviving this one.'
		}
	]
};

/**
 * Guards whose premise a KNOWN, PLANNED change will invalidate, with the call made in advance.
 *
 * XR-VER-07's failure mode is a reviewer meeting a red they were not expecting and resolving it by
 * deleting the assertion. The remedy is to decide the retire-or-re-anchor question BEFORE the change
 * lands, next to the guard, and then to check that the record and the guard have not drifted apart.
 *
 * `anchor` is text that must still be present in `file`. If the guard is edited away without updating
 * this record, that mismatch reds — so a stale ruling cannot sit here looking authoritative.
 */
const PENDING_RULING: { file: string; anchor: string; ruling: string }[] = [
	/*
	 * RESOLVED AND REMOVED BY #903 — the QueueSheet drawer-port ruling that lived here.
	 *
	 * Its anchor was `RECORDED RULING FOR THE QUEUESHEET DRAWER PORT (#827)` in design-system.test.ts,
	 * and its call was RE-ANCHOR, DO NOT DELETE for the dvh sheet-cap scan and the `.peek` env() scan.
	 * That call was right for the change it anticipated — a PORT, where both sheets still existed at a
	 * new address. What actually happened was a REMOVAL: #903 deleted the drawer surface outright, so
	 * the dvh scan had no address left to move to and was retired (see RETIRED, with its reason), while
	 * the `.peek` env() scan DID have a live successor and was re-anchored to the docked bands
	 * (`.cta-dock` / `.search-dock`) rather than dropped — which is the half of the ruling that
	 * survived contact. Both outcomes are on the record; this entry is gone because its anchor is.
	 */
	{
		file: 'apps/core/src/lib/contrast.test.ts',
		anchor: 'RECORDED RULING FOR THE PALETTE MIGRATION',
		ruling:
			'The accent-as-ink ban self-reports: its first arm asserts the pairs FAIL AA (toBeLessThan), so a ' +
			'palette whose stops clear AA as ink reds that line rather than passing vacuously. The handoff ' +
			'predicted the opposite. Ruling: re-anchor, do not delete — drop the contrast arm only, keep the ' +
			'usage scan, and record the swap. The full ruling is at the anchor above. ' +
			'EXECUTED by #840 (XR-COL-11): the trigger was not a red but `--accent-strong`\u2019s retirement ' +
			'removing the loop\u2019s second operand, so the arm could not be left alone in any case. The ' +
			'contrast arm is dropped (accent-as-ink is now per-stop and mostly FALSE — 35 of 48 fills clear ' +
			'AA on --card), the usage scan is kept verbatim, and the XR-VER-06 swap record sits under the ' +
			'anchor. This entry stays here rather than moving to RETIRED because nothing was given up: the ' +
			'anchor and the guard it describes are both still present, which is what this check verifies.'
	}
];

/** Locate a floor assertion on `subject` and return every literal asserted against it. */
function assertedLiterals(src: string, subject: string): number[] {
	const esc = subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(String.raw`expect\(\s*${esc}\s*\)\s*\.\s*toBeGreaterThan(?:OrEqual)?\(\s*(\d+)\s*\)`, 'g');
	return [...src.matchAll(re)].map((m) => Number(m[1]));
}

test('every recorded non-vacuity floor is still present, and no weaker than recorded', () => {
	const offenders: string[] = [];
	let located = 0;
	for (const [rel, floors] of Object.entries(FLOORS)) {
		const abs = join(REPO, rel);
		if (!existsSync(abs)) {
			offenders.push(
				`${rel}: file is gone — retire its floors on the record (see RETIRED) rather than deleting them silently`
			);
			continue;
		}
		const src = readFileSync(abs, 'utf8');
		for (const f of floors) {
			const lits = assertedLiterals(src, f.subject);
			if (lits.length === 0) {
				offenders.push(`${rel}: floor on \`${f.subject}\` (>= ${f.min}) is GONE — it guarded ${f.guards}`);
				continue;
			}
			const strong = lits.filter((n) => n >= f.min);
			if (strong.length < f.count) {
				offenders.push(
					`${rel}: floor on \`${f.subject}\` LOWERED — found [${lits.join(', ')}], need ${f.count} at >= ${f.min}. ` +
						`It guarded ${f.guards}. A firing floor is a finding, never a number to adjust.`
				);
				continue;
			}
			located += f.count;
		}
	}
	expect(offenders).toEqual([]);
	// This guard's OWN non-vacuity floor. Without it, a broken `assertedLiterals` regex, an emptied
	// FLOORS map, or a bad REPO root would make the loop above examine nothing and pass — the exact
	// class of failure this file exists to detect, one level up.
	//
	// ⚠ THIS LITERAL MUST EQUAL THE SUM OF EVERY `count` IN `FLOORS`, EXACTLY. `located` accumulates
	// `f.count` per located floor, so any slack between the sum and this number is a LAUNDERING
	// ALLOWANCE: a floor can be deleted from its source file AND its entry removed from `FLOORS`
	// together, and `located` still clears a floor set below the sum. That green run is indistinguishable
	// from a healthy one, which is precisely the hole this file exists to close — one level up again.
	// So when you add an entry to `FLOORS`, raise this by the same amount in the same commit; when you
	// retire one to `RETIRED`, lower it by the same amount. Measured directly rather than counted by
	// eye: temporarily raise this literal absurdly high, run this file alone, and read `Received: N`.
	// 38 as of #829 (29 on its base once #831 added `boxRulesSeen`; +9 for the nine enumerating scans
	// #829 adds to design-system.test.ts — five dimension-duplication scans, the two @theme bridge scans,
	// the ladder-ordering rungs, and the phone-ladder-on-TV ban). +1 for #852's breakpoint-membership
	// `literalsFound` floor, and +1 for #859's `mintSurfaces` floor on the XR-COL-14 colour ban
	// (tailwind-toolchain.test.ts), giving 40. Measured the way this comment prescribes, not counted:
	// raised absurdly high, read `Received: 40`.
	// -1 for #903 retiring design-system.test.ts's `scanned` floor to RETIRED (its guard's entire
	// population was the two deleted drawer components), and +1 for the `scanned` floor on the #903
	// deletion guard that replaces it (drawer-surface-removed-903.test.ts) — net UNCHANGED at 40. One
	// population-counting floor out, one in, in the same commit. Re-measured the way this comment
	// prescribes rather than counted: raised absurdly high, read `Received: 40`.
	expect(located).toBeGreaterThanOrEqual(40);
	expect(Object.keys(FLOORS).length).toBeGreaterThanOrEqual(12);
});

test('a retired floor is retired on the record: substantive reason, and genuinely gone', () => {
	const offenders: string[] = [];
	for (const [rel, entries] of Object.entries(RETIRED)) {
		for (const e of entries) {
			// (1) a reason, not a shrug. XR-VER-06 wants the invariant, the sites that left scope, and what
			// covers them now — none of which fits in a few words.
			if (e.reason.trim().length < 60) {
				offenders.push(
					`${rel}: retired \`${e.subject}\` with no substantive reason (got ${e.reason.trim().length} chars)`
				);
			}
			// (2) it cannot be BOTH retired and live. A floor parked here while a weakened copy stays in the
			// source is exactly the laundering this record is meant to prevent.
			if (FLOORS[rel]?.some((f) => f.subject === e.subject)) {
				offenders.push(`${rel}: \`${e.subject}\` is in both FLOORS and RETIRED — one of the two is wrong`);
			}
			const abs = join(REPO, rel);
			if (existsSync(abs) && assertedLiterals(readFileSync(abs, 'utf8'), e.subject).length > 0) {
				offenders.push(
					`${rel}: \`${e.subject}\` is recorded as retired but a floor on it is still in the source — ` +
						`retire means the assertion is gone, not that its number was reduced`
				);
			}
		}
	}
	expect(offenders).toEqual([]);
});

test('every guard with a planned premise change carries a ruling that still matches its guard', () => {
	const offenders: string[] = [];
	for (const p of PENDING_RULING) {
		const abs = join(REPO, p.file);
		if (!existsSync(abs)) {
			offenders.push(`${p.file}: recorded a ruling for a file that no longer exists — resolve the ruling or drop it`);
			continue;
		}
		if (!readFileSync(abs, 'utf8').includes(p.anchor)) {
			offenders.push(
				`${p.file}: the recorded ruling's anchor ${JSON.stringify(p.anchor)} is gone. Either the guard was ` +
					`edited without resolving the ruling, or the ruling was resolved without removing this entry.`
			);
		}
		if (p.ruling.trim().length < 60) offenders.push(`${p.file}: ruling is not substantive enough to act on`);
	}
	expect(offenders).toEqual([]);
	// non-vacuity: an emptied PENDING_RULING would make this test pass while checking nothing.
	expect(PENDING_RULING.length).toBeGreaterThanOrEqual(1);
});
