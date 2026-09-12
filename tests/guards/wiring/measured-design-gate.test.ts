// guard: the fifth gate is WIRED, and its register is not vacuous (XR-VER-02).
//
// ── WHY A SOURCE SCAN GUARDS A MEASURED GATE ───────────────────────────────────────────────────
//
// The measured-design gate moved four measurement claims onto real headless Chromium. The measurement itself is in
// `tests/e2e/gates/measured-design.mjs`, which needs a browser and a booted server and therefore
// cannot run inside `bun test`. That leaves a gap this file closes, and it is the same gap the issue's
// own triage named: a measured check nothing runs is not a gate.
//
// So this asserts the WIRING, which is decidable from source on every box:
//
//   1. the gate exists and imports the layout-rung driver — literally XR-VER-02's own Check
//   2. it is declared as a script in the root package.json, so `bun run gate:measured` resolves
//   3. it is in the gate list of ALL FOUR committed briefs, because that list is what every lane reads
//   4. it has no skip path — owner ruling on Q1 was A over B, "a missing browser is a red gate"
//   5. every quarantine entry carries a substantive reason, the RETIRED-map convention from
//      non-vacuity-floors.test.ts, so a control cannot be parked below the floor with a shrug
//   6. the register's constants still agree with the tokens they mirror
//
// What this file deliberately does NOT do is re-implement any of the four claims. A source scan
// standing in for a measurement is the exact thing XR-VER-02 forbids; the four assertions live in the
// gate, on the rung where they are decidable.
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '@encore/test-support';
// A relative IMPORT specifier, because `at()` yields a runtime string and cannot appear in an import.
// It fails loudly (`Cannot find module`) if the depth is wrong, unlike a scan root.
import {
	CONTROL_SELECTOR,
	FLOORS,
	MIN_FIELD_PX,
	QUARANTINE,
	RETIRED,
	TAP,
	TAP_FLOOR
} from '../../../tests/e2e/gates/measured-design-register.mjs';

// Anchored on the repo-root marker rather than `at('.')`, which
// only meant the repo root while this file sat in src/lib.
const REPO = repoRoot;
const GATE_REL = 'tests/e2e/gates/measured-design.mjs';
const gate = readFileSync(join(REPO, GATE_REL), 'utf8');

/** The script name every lane runs. Changing it means changing all four briefs in the same commit. */
const SCRIPT = 'gate:measured';

/** The four ratified requirements, one per claim, each of which must be measured by the gate. */
const CLAIMS = ['XR-VER-09', 'XR-VER-10', 'XR-VER-11', 'XR-VER-12'];

/**
 * Briefs that ENUMERATE the gate list, so each must name the fifth gate by script name. Verified site by
 * site on b798643: COMMON.md:59-68, CODING-BOT.md:133-142, CONDUCTOR.md:113 + :176, PR-BOT.md:158 + :173,
 * HANDOFF.md:81-87.
 */
const GATE_LIST_BRIEFS = [
	'docs/loop/COMMON.md',
	'docs/loop/CODING-BOT.md',
	'docs/loop/CONDUCTOR.md',
	'docs/loop/PR-BOT.md',
	'docs/HANDOFF.md'
];

/**
 * EVERY brief a lane can be seeded from, derived by WALKING `docs/loop/` rather than hand-listed, plus the
 * repo handoff. A hand-listed population is how `/metrics` and `lib/charts` stayed invisible:
 * the guard was correct and simply never looked at them. Three new files landed into `docs/loop/`
 * DURING this PR's review and one of them (`REVIEW-ORCHESTRATOR.md`) carried the same stale count — a walk
 * picks that up on the next run with nobody remembering to extend a list.
 */
function briefFiles(): string[] {
	const dir = join(REPO, 'docs', 'loop');
	const out = readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith('.md'))
		.map((e) => `docs/loop/${e.name}`);
	out.push('docs/HANDOFF.md');
	return out;
}

test('the measured-design gate imports the layout-rung driver, and names each claim it measures', () => {
	// XR-VER-02's Check, verbatim: "for each measurement-classified entry, assert its implementing
	// file imports the layout-rung driver". `cdp.mjs` IS the layout rung.
	expect(gate).toMatch(/import \{[^}]*\bconnect\b[^}]*\} from '\.\.\/cdp\.mjs';/);
	// …and the Chromium it drives is discovered through the single-sourced helper, not a private copy
	//. e2e/lib/chromium.test.ts bans a redefinition; this pins that this gate uses it.
	expect(gate).toMatch(/import \{ findChromium \} from '\.\.\/lib\/chromium\.mjs';/);
	for (const claim of CLAIMS) {
		expect(gate, `${GATE_REL} must carry a check naming ${claim}`).toContain(claim);
	}
});

test('the measured-design gate has no skip path — a missing browser is a red gate, not a green one', () => {
	// Owner ruling on Q1 was A, chosen over B ("skips when no server or Chromium is present"),
	// because e2e/contract.test.ts:23 had already ruled that a permanently-skipped test is
	// indistinguishable from the rot it was meant to catch. Every other e2e driver in this tree uses
	// exit 2 for "the environment could not host this"; this gate must NOT, because exit 2 read as a
	// pass is precisely how four unchecked claims would report as checked.
	expect(gate).not.toMatch(/process\.exit\(2\)/);
	// and the precondition helper must actually record a FAILED check before exiting
	expect(gate).toMatch(/function unmeetable\([\s\S]*?check\(name, false/);
});

test(`the fifth gate is declared as \`${SCRIPT}\` in the root package.json`, () => {
	const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
	expect(pkg.scripts?.[SCRIPT]).toBeString();
	// It must point at the real gate, not at a stub or another driver.
	expect(pkg.scripts[SCRIPT]).toContain(GATE_REL);
});

test('every brief that enumerates the gates lists the fifth one', () => {
	// A brief that ENUMERATES the gate list must name the fifth gate, or a lane seeded from it runs four and
	// the four measurement claims are decided by nothing. Verified site by site on b798643.
	//
	// REVIEW-ORCHESTRATOR.md is deliberately NOT here: it delegates the gate list to COMMON.md by reference
	// rather than restating it, so demanding the string there would force a mention into a file whose whole
	// point is not carrying its own copy. The count arm below is what guards it — and that arm is the one
	// that would have caught the defect THIS test missed.
	const missing: string[] = [];
	for (const rel of GATE_LIST_BRIEFS) {
		const src = readFileSync(join(REPO, rel), 'utf8');
		if (!src.includes(SCRIPT)) missing.push(rel);
	}
	expect(missing).toEqual([]);
	// non-vacuity: an emptied list would make the loop above examine nothing and pass
	expect(GATE_LIST_BRIEFS.length).toBeGreaterThanOrEqual(5);
});

test('no brief still states a stale gate COUNT — the gap that let a partial update pass', () => {
	// THE DEFECT THIS EXISTS FOR, and it was this file's own. The test above asserts `gate:measured` appears
	// SOMEWHERE in each brief. `docs/loop/CONDUCTOR.md` satisfied that — the fifth gate was in its dispatch
	// list at :113 — while two OPERATIVE rules in the same file still said four:
	//
	//   :22  "Workers MUST run all four gates every time."          <- the worker-seed instruction
	//   :142 "the four gates, re-measured, never taken on trust."   <- self-merge criterion 1
	//
	// So a worker seeded from that file ran four gates, `gate:measured` never ran on its own PR, and :142
	// authorised a self-merge on four green. A presence check cannot see that: the string it looks for was
	// right there in the same file, a hundred lines from a rule contradicting it. Nine further sites carried
	// the same drift across CONDUCTOR, COMMON, CODING-BOT, REVIEW-ORCHESTRATOR and HANDOFF.
	//
	// So this arm checks the NUMBER instead of a mention, and it is forward-proof on purpose: any count word
	// before "gates" other than "five" reds, so adding a SIXTH gate breaks this test rather than silently
	// leaving eleven briefs claiming five.
	const STALE_COUNT = /\b(?:one|two|three|four|six|seven|eight|nine|ten|\d+)\s+gates\b/i;
	// "gates … all four" and "all four … gates" on ONE line — HANDOFF.md's phrasing, which the count pattern
	// alone does not match. Line-scoped so it cannot reach across sentences, and it does not fire on
	// PR-BOT.md's "The four charters — run all four on every PR", which says no "gates".
	const COUNTS = 'one|two|three|four|six|seven|eight|nine|ten';
	const STALE_ALL = new RegExp(`(?:gates[^.\\n]*\\ball (?:${COUNTS})\\b|\\ball (?:${COUNTS})\\b[^.\\n]*gates)`, 'i');

	const offenders: string[] = [];
	const scanned: string[] = [];
	for (const rel of briefFiles()) {
		const src = readFileSync(join(REPO, rel), 'utf8');
		scanned.push(rel);
		src.split('\n').forEach((line, i) => {
			const count = line.match(STALE_COUNT);
			if (count) offenders.push(`${rel}:${i + 1}: a stale gate count — ${JSON.stringify(count[0])}`);
			const all = line.match(STALE_ALL);
			if (all) offenders.push(`${rel}:${i + 1}: an "all <n>" gate instruction — ${JSON.stringify(all[0])}`);
		});
	}
	expect(offenders).toEqual([]);
	// Non-vacuity floor (XR-VER-05): a walk that stops finding briefs reports zero offenders over zero files,
	// which is exactly the silent-green this arm exists to prevent, one level up. 12 files under docs/loop
	// plus docs/HANDOFF.md on b798643. A firing floor is a FINDING, never a number to adjust (XR-VER-06).
	expect(scanned.length).toBeGreaterThanOrEqual(10);
});

test('the CDP driver exposes exactly ONE safe-area method, and every caller uses that name', () => {
	// THE COLLISION THIS EXISTS FOR. Two branches both needed a safe-area override and both added one to
	// the shared driver in the same hour: `setSafeAreaInsets` here, `safeAreaInsets` on main. Same
	// body, same CDP call, two names — and the merge conflicted on the hunk. This side dropped its own and
	// adopted the incumbent, so `cdp.mjs` is untouched by this PR. This arm is what stops a THIRD.
	//
	// It is the same defect class `e2e/lib/chromium.test.ts` guards for `findChromium`, which was
	// copy-pasted into 15 drivers and drifted three ways — except here the duplication would
	// be two NAMES for one capability rather than two copies of one name, which no import check can see.
	//
	// Definition-only detection, mirroring that file's approach: match the method DEFINITIONS on the page
	// object, never a call site and never the CDP wire method (`Emulation.setSafeAreaInsetsOverride`),
	// which is the protocol's name and not ours to dedupe.
	const cdp = readFileSync(join(REPO, 'tests/e2e/cdp.mjs'), 'utf8');
	const defined = [...cdp.matchAll(/^\t\tasync\s+(\w+)\s*\(/gm)].map((m) => m[1]!).filter((n) => /safearea/i.test(n));
	expect(defined).toEqual(['safeAreaInsets']);

	// …and every caller across the whole e2e tree must spell that one name. A second name that nothing
	// defines is a build break the type gate would catch, but a second name that a third PR DEFINES is
	// exactly the state above, and this is the assertion that reds on it.
	const offenders: string[] = [];
	let callsSeen = 0;
	const walk = (dir: string) => {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (ent.name === 'node_modules' || ent.name === 'build') continue;
			const abs = join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(abs);
				continue;
			}
			if (!ent.name.endsWith('.mjs') && !ent.name.endsWith('.ts')) continue;
			const src = readFileSync(abs, 'utf8');
			for (const m of src.matchAll(/\.(\w*safeArea\w*)\s*\(/gi)) {
				const name = m[1]!;
				callsSeen++;
				if (!defined.includes(name)) {
					offenders.push(
						`${abs.slice(REPO.length + 1)}: calls .${name}(), but the driver defines ${JSON.stringify(defined)}`
					);
				}
			}
		}
	};
	walk(join(REPO, 'tests/e2e'));
	expect(offenders).toEqual([]);
	// Non-vacuity floor (XR-VER-05): TWO call sites today — this gate's live docked-band arm sets a
	// simulated inset and then resets it. A walk that finds none would pass while enforcing nothing.
	//
	// XR-VER-06 RECORD — LOWERED 4 -> 2 by the queue-sheet removal. The INVARIANT is untouched: one name for the capability,
	// and every caller in the e2e tree spells it. What shrank is the POPULATION. The other two callers
	// were the drawer probe (e2e/probes/spike827-queuesheet-drawer.mjs, deleted whole with the drawer
	// surface) and this gate's own sheet half (deleted with it, since it measured the peek's safe-area
	// term on a component that no longer exists). Nothing is unenforced by the drop: the walk still
	// covers the ENTIRE e2e tree, and `defined` above still pins the driver to exactly one method name,
	// so a third name added by a future PR reds here exactly as before. A firing floor is a FINDING.
	expect(callsSeen).toBeGreaterThanOrEqual(2);
});

test('every quarantined control carries a substantive reason and a real identity to match on', () => {
	const offenders: string[] = [];
	for (const q of QUARANTINE) {
		const who = `${q.where} ${q.match.tag}`;
		// Same 60-character bar as non-vacuity-floors.test.ts's RETIRED map: XR-VER-06 wants the
		// invariant, what left scope, and what covers it now, none of which fits in a few words.
		if (q.reason.trim().length < 60)
			offenders.push(`${who}: reason is not substantive (${q.reason.trim().length} chars)`);
		// A quarantine that matches on a tag alone would absorb every future offender of that tag.
		const fields = Object.values(q.match).filter((v) => v !== undefined).length;
		if (fields < 2) offenders.push(`${who}: matches on ${fields} field(s) — too loose to be a single control`);
		// A number at or above the floor is not a quarantine, it is a stale entry.
		if (q.measured >= TAP) offenders.push(`${who}: recorded at ${q.measured}px, which is not below the ${TAP}px floor`);
		if (q.measured <= 0)
			offenders.push(`${who}: recorded at ${q.measured}px — a zero measurement is UNMEASURED (XR-VER-03)`);
	}
	// A RETIRED entry (a control that WAS quarantined and is now resolved) carries the same
	// identity + substantive-reason bar. `was` is the number it measured while quarantined, so it
	// must be a real sub-floor reading — a >= TAP `was` would mean it was never a defect.
	for (const q of RETIRED) {
		const who = `${q.where} ${q.match.tag} (retired)`;
		if (q.reason.trim().length < 60)
			offenders.push(`${who}: reason is not substantive (${q.reason.trim().length} chars)`);
		const fields = Object.values(q.match).filter((v) => v !== undefined).length;
		if (fields < 2) offenders.push(`${who}: matches on ${fields} field(s) — too loose to be a single control`);
		if (q.was >= TAP) offenders.push(`${who}: recorded at ${q.was}px, which was never below the ${TAP}px floor`);
		if (q.was <= 0) offenders.push(`${who}: recorded at ${q.was}px — a zero measurement is UNMEASURED (XR-VER-03)`);
	}
	expect(offenders).toEqual([]);
	// non-vacuity: the gate started with four known sub-floor controls. All four were later resolved — three
	// CSS fixes and one false positive — so they moved from QUARANTINE to RETIRED rather than vanishing.
	// Pin the COMBINED set at the original four so neither list can be silently emptied: dropping a
	// quarantine entry without recording its resolution in RETIRED reds here. (XR-VER-06/07.)
	expect(QUARANTINE.length + RETIRED.length).toBeGreaterThanOrEqual(4);
});

test('the register mirrors the tokens it measures against, so the two cannot drift apart', () => {
	const css = readFileSync(join(REPO, 'src/app.css'), 'utf8');
	// `TAP` is parsed out of this very declaration now (the register), so asserting it
	// equals TAP compares the value to itself. What is still a real question — and the reason the
	// register imports a separate floor — is whether the token still holds the app's commitment.
	expect(css).toMatch(/--tap:\s*[0-9.]+px\s*;/);
	expect(TAP).toBeGreaterThanOrEqual(TAP_FLOOR);
	// XR-VER-11 RECORD — the sheet-cap arm was RETIRED here with the queue-sheet removal, not weakened. It asserted
	// `SHEET_CAP_FRACTION === 0.82` and that QueueSheet.svelte declared `max-height: 82dvh`; the drawer
	// surface that owned that declaration was deleted, so the number had no source left to mirror and
	// SHEET_CAP_FRACTION went with it out of the register. Nothing docked caps itself in a viewport
	// fraction now — the docked band is sized by its own content and published as --dock-h — so there is
	// no successor declaration to re-point at, and inventing one would pin a cap no surface asks for.
	// SIMULATED_BOTTOM_INSET deliberately STAYS: the live .cta-dock safe-area arm still uses it.
	// The 16px threshold is a WebKit behaviour, renegotiable only on evidence about WebKit.
	expect(MIN_FIELD_PX).toBe(16);
});

test('the gate derives its control set from roles, not from a class allowlist', () => {
	// touch-targets.test.ts was corrected once already for deriving "is this a control?" from a
	// literal allowlist, which is how /metrics and lib/charts stayed invisible. The
	// replacement must not re-introduce it: the selector has to name roles and element types.
	for (const needed of ['button', 'a[href]', 'select', 'textarea', '[role="button"]']) {
		expect(CONTROL_SELECTOR).toContain(needed);
	}
	// The gate's own non-vacuity floors must exist and be meaningful — XR-VER-05 applies to a measured
	// guard as much as to a source scan, because a drive that navigates but finds nothing reports every
	// assertion satisfied over an empty set. A firing floor is a FINDING, never a number to adjust.
	for (const [name, min] of Object.entries(FLOORS)) {
		expect(min, `FLOORS.${name} must be a positive floor`).toBeGreaterThan(0);
		expect(gate, `the gate must actually assert FLOORS.${name}`).toContain(`FLOORS.${name}`);
	}
	expect(Object.keys(FLOORS).length).toBeGreaterThanOrEqual(4);
});
