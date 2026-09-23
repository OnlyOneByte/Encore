// The measured-design gate is WIRED and its register is not vacuous. The four measurement claims live
// in `tests/e2e/gates/measured-design.mjs`, which needs a browser and a booted server and so cannot run
// under `bun test`; this file asserts only the wiring, never re-implementing a claim, because a source
// scan standing in for a measurement is the thing the rule forbids.
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '@encore/test-support';
// A literal specifier, not a runtime-built path: it fails loudly with `Cannot find module` on a wrong
// depth, where a scan root would silently resolve to nothing.
import {
	CONTROL_SELECTOR,
	FLOORS,
	MIN_FIELD_PX,
	QUARANTINE,
	RETIRED,
	TAP,
	TAP_FLOOR
} from '$e2e/gates/measured-design-register.mjs';

const REPO = repoRoot;
const GATE_REL = 'tests/e2e/gates/measured-design.mjs';
const gate = readFileSync(join(REPO, GATE_REL), 'utf8');

/** The script name every lane runs. Changing it means changing all four briefs in the same commit. */
const SCRIPT = 'gate:measured';

/**
 * The four measured claims, keyed on the SUBJECT each one measures rather than on a requirement id: an
 * id only proves a label was pasted in, where a subject reds when a renamed claim stops measuring it.
 */
const CLAIMS = [
	'measured hit extent',
	'text-entry field computes',
	"--dock-h equals the docked band's REAL rendered height",
	'outline in the resolved --focus'
];

test('the measured-design gate imports the layout-rung driver, and names each claim it measures', () => {
	// `driver.mjs` IS the layout rung — a measurement-classified check must import it.
	expect(gate).toMatch(/import \{[^}]*\bconnect\b[^}]*\} from '\.\.\/driver\.mjs';/);
	// Chromium comes from the single-sourced helper, never a private copy: `e2e/lib/chromium.test.ts`
	// bans a redefinition, and this pins that this gate consumes it.
	expect(gate).toMatch(/import \{ findChromium \} from '\.\.\/lib\/chromium\.mjs';/);
	for (const claim of CLAIMS) {
		expect(gate, `${GATE_REL} must carry a check naming ${claim}`).toContain(claim);
	}
});

test('the measured-design gate has no skip path — a missing browser is a red gate, not a green one', () => {
	// Every other e2e driver here uses exit 2 for "the environment could not host this"; this gate must
	// NOT, because exit 2 read as a pass is how four unchecked claims report as checked.
	expect(gate).not.toMatch(/process\.exit\(2\)/);
	// …and the precondition helper must record a FAILED check before exiting.
	expect(gate).toMatch(/function unmeetable\([\s\S]*?check\(name, false/);
});

test(`the fifth gate is declared as \`${SCRIPT}\` in the root package.json`, () => {
	const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
	expect(pkg.scripts?.[SCRIPT]).toBeString();
	// It must point at the real gate, not at a stub or another driver.
	expect(pkg.scripts[SCRIPT]).toContain(GATE_REL);
});

test('the CDP driver exposes exactly ONE safe-area method, and every caller uses that name', () => {
	// Caught: two branches each added a safe-area override to the shared driver under a different name
	// (`setSafeAreaInsets` vs `safeAreaInsets`) — same body, same CDP call, two names, which no import
	// check can see. The regex matches method DEFINITIONS on the page object only, never a call site and
	// never the CDP wire method `Emulation.setSafeAreaInsetsOverride`, which is the protocol's name.
	const cdp = readFileSync(join(REPO, 'tests/e2e/driver.mjs'), 'utf8');
	const defined = [...cdp.matchAll(/^\t\tasync\s+(\w+)\s*\(/gm)].map((m) => m[1]!).filter((n) => /safearea/i.test(n));
	expect(defined).toEqual(['safeAreaInsets']);

	// …and every caller across the whole e2e tree must spell that one name.
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
						`${abs.slice(REPO.length + 1)}: calls.${name}(), but the driver defines ${JSON.stringify(defined)}`
					);
				}
			}
		}
	};
	walk(join(REPO, 'tests/e2e'));
	expect(offenders).toEqual([]);
	// Non-vacuity floor: the docked-band arm sets a simulated inset then resets it, so there are exactly
	// two call sites. A walk that found none would pass while enforcing nothing.
	expect(callsSeen).toBeGreaterThanOrEqual(2);
});

test('every quarantined control carries a substantive reason and a real identity to match on', () => {
	const offenders: string[] = [];
	for (const q of QUARANTINE) {
		const who = `${q.where} ${q.match.tag}`;
		// 60 chars is the same bar as `non-vacuity-floors.test.ts`'s RETIRED map: the invariant, what
		// left scope, and what covers it now does not fit in a few words.
		if (q.reason.trim().length < 60)
			offenders.push(`${who}: reason is not substantive (${q.reason.trim().length} chars)`);
		// A quarantine matching on a tag alone would absorb every future offender of that tag.
		const fields = Object.values(q.match).filter((v) => v !== undefined).length;
		if (fields < 2) offenders.push(`${who}: matches on ${fields} field(s) — too loose to be a single control`);
		// A number at or above the floor is not a quarantine, it is a stale entry.
		if (q.measured >= TAP) offenders.push(`${who}: recorded at ${q.measured}px, which is not below the ${TAP}px floor`);
		if (q.measured <= 0) offenders.push(`${who}: recorded at ${q.measured}px — a zero measurement is UNMEASURED`);
	}
	// A RETIRED entry carries the same bar, and its `was` must be a real sub-floor reading: a `was` at
	// or above TAP would mean the control was never a defect.
	for (const q of RETIRED) {
		const who = `${q.where} ${q.match.tag} (retired)`;
		if (q.reason.trim().length < 60)
			offenders.push(`${who}: reason is not substantive (${q.reason.trim().length} chars)`);
		const fields = Object.values(q.match).filter((v) => v !== undefined).length;
		if (fields < 2) offenders.push(`${who}: matches on ${fields} field(s) — too loose to be a single control`);
		if (q.was >= TAP) offenders.push(`${who}: recorded at ${q.was}px, which was never below the ${TAP}px floor`);
		if (q.was <= 0) offenders.push(`${who}: recorded at ${q.was}px — a zero measurement is UNMEASURED`);
	}
	expect(offenders).toEqual([]);
	// Non-vacuity, over the COMBINED set: resolving a quarantine must move it to RETIRED, so dropping an
	// entry without recording its resolution reds here rather than silently emptying a list.
	expect(QUARANTINE.length + RETIRED.length).toBeGreaterThanOrEqual(4);
});

test('the register mirrors the tokens it measures against, so the two cannot drift apart', () => {
	const css = readFileSync(join(REPO, 'src/app.css'), 'utf8');
	// `TAP` is parsed out of this declaration, so comparing it to the token compares a value to itself;
	// the separate `TAP_FLOOR` is what still asks whether the token holds the app's commitment.
	expect(css).toMatch(/--tap:\s*[0-9.]+px\s*;/);
	expect(TAP).toBeGreaterThanOrEqual(TAP_FLOOR);
	// 16px is a WebKit behaviour (a smaller font-size triggers zoom-on-focus), renegotiable only on
	// evidence about WebKit.
	expect(MIN_FIELD_PX).toBe(16);
});

test('the gate derives its control set from roles, not from a class allowlist', () => {
	// Caught in `touch-targets.test.ts`: deriving "is this a control?" from a literal class allowlist is
	// how /metrics and lib/charts stayed invisible, so the selector must name roles and element types.
	for (const needed of ['button', 'a[href]', 'select', 'textarea', '[role="button"]']) {
		expect(CONTROL_SELECTOR).toContain(needed);
	}
	// A drive that navigates but finds nothing reports every assertion satisfied over an empty set, so a
	// measured gate needs non-vacuity floors as much as a source scan does.
	for (const [name, min] of Object.entries(FLOORS)) {
		expect(min, `FLOORS.${name} must be a positive floor`).toBeGreaterThan(0);
		expect(gate, `the gate must actually assert FLOORS.${name}`).toContain(`FLOORS.${name}`);
	}
	expect(Object.keys(FLOORS).length).toBeGreaterThanOrEqual(4);
});
