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
	'apps/core/src/lib/task-number-hygiene.test.ts': [
		{
			subject: 'files.length',
			min: 50,
			count: 2,
			guards:
				'the repo-wide task-number walk; an unanchored `git ls-files` returning nothing passed with zero files scanned'
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
			min: 10,
			count: 1,
			guards:
				'the scanned POPULATION, added by #841. FILES is a walk over lib/components plus five hand-named route pages, so a walk contributing nothing still leaves five files \u2014 and five files carry enough control rules that `controlRulesSeen` above stays green (measured). The two floors fail on different regressions.'
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
		{ subject: 'scanned', min: 1, count: 1, guards: 'the sheets examined by the sheet-level scan' }
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
const RETIRED: Record<string, { subject: string; reason: string }[]> = {};

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
	{
		file: 'apps/core/src/lib/contrast.test.ts',
		anchor: 'RECORDED RULING FOR THE PALETTE MIGRATION',
		ruling:
			'The accent-as-ink ban self-reports: its first arm asserts the pairs FAIL AA (toBeLessThan), so a ' +
			'palette whose stops clear AA as ink reds that line rather than passing vacuously. The handoff ' +
			'predicted the opposite. Ruling: re-anchor, do not delete — drop the contrast arm only, keep the ' +
			'usage scan, and record the swap. The full ruling is at the anchor above.'
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
	// 28 as of #841 (26 on the base, which had drifted 4 below the sum when #846 added three entries
	// without moving this number; restoring the equality closes that inherited slack too).
	expect(located).toBeGreaterThanOrEqual(28);
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
