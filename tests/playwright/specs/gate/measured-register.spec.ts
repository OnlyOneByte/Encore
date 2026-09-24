/*
 * THE REGISTER'S OWN SHAPE — the arms that used to live in `tests/guards/wiring/measured-design-gate.test.ts`
 * and ran in `bun test` on every box. That whole tree is deleted, and its rationale was exactly the hole that
 * left: "a register only the gate can read is a register nobody checks when the gate does not run." So the
 * register-shape arms move INSIDE the gate here. The gate now refuses to run against an empty or vacuous
 * register, which is strictly less than a guard on every box and is recorded as such in
 * measured-design-register.ts.
 *
 * NO WORLD, NO CORE, NO BROWSER: this test asks nothing of the app, so it does not request the `world`
 * fixture and no core boots for it. It is in the `gate` project because it must fail the same build the
 * measurements do — a vacuous register is not a lesser failure than a short control.
 *
 * WHAT DID NOT COME ACROSS, and why: the deleted guard also source-scanned the old gate file (that it imports
 * `connect` from driver.mjs, that it names each of the four claims, that it has no `process.exit(2)`, and that
 * `package.json` points `gate:measured` at it) and scanned the whole e2e tree for a second spelling of the
 * safe-area driver method. Every one of those is about the SHAPE of a file this port replaces: there is no
 * driver.mjs here, the no-skip rule is now structural (playwright.config.ts's globalSetup fails on an unbuilt
 * tree; world/core.ts throws when core will not answer /health), and a spec's discovery is its directory. The
 * one arm with a live subject — that every FLOORS key is actually asserted by some spec — is kept below.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test, expect } from '../../world/fixtures';
import { repoRoot } from '../../world/core';
import {
	CONTROL_SELECTOR,
	FLOORS,
	MIN_FIELD_PX,
	QUARANTINE,
	RETIRED,
	SIMULATED_BOTTOM_INSET,
	TAP,
	TAP_FLOOR,
	TEXT_INPUT_TYPES,
	VIEWPORTS
} from './measured-design-register';

const HERE = fileURLToPath(new URL('.', import.meta.url));

test('every quarantined control carries a substantive reason and a real identity to match on', () => {
	const offenders: string[] = [];
	for (const q of QUARANTINE) {
		const who = `${q.where} ${q.match.tag}`;
		// 60 chars is the bar the deleted guard set: the invariant, what left scope, and what covers it now
		// does not fit in a few words.
		if (q.reason.trim().length < 60)
			offenders.push(`${who}: reason is not substantive (${q.reason.trim().length} chars)`);
		// A quarantine matching on a tag alone would absorb every future offender of that tag.
		const fields = Object.values(q.match).filter((v) => v !== undefined).length;
		if (fields < 2) offenders.push(`${who}: matches on ${fields} field(s) — too loose to be a single control`);
		// A number at or above the floor is not a quarantine, it is a stale entry.
		if (q.measured >= TAP) offenders.push(`${who}: recorded at ${q.measured}px, which is not below the ${TAP}px floor`);
		if (q.measured <= 0) offenders.push(`${who}: recorded at ${q.measured}px — a zero measurement is UNMEASURED`);
	}
	// A RETIRED entry carries the same bar, and its `was` must be a real sub-floor reading: a `was` at or above
	// TAP would mean the control was never a defect.
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
	// Non-vacuity, over the COMBINED set: resolving a quarantine must move it to RETIRED, so dropping an entry
	// without recording its resolution reds here rather than silently emptying a list.
	expect(QUARANTINE.length + RETIRED.length).toBeGreaterThanOrEqual(4);
});

test('the register mirrors the tokens it measures against, so the two cannot drift apart', () => {
	const css = readFileSync(join(repoRoot, 'src/app.css'), 'utf8');
	// `TAP` is parsed out of this declaration, so comparing it to the token compares a value to itself; the
	// separate `TAP_FLOOR` is what still asks whether the token holds the app's commitment.
	expect(css).toMatch(/--tap:\s*[0-9.]+px\s*;/);
	// A REAL POSITIVE NUMBER, said out loud: a `--tap: banana` or a deleted token would make `Number(...)` NaN,
	// and every `hitH >= TAP` comparison then reads false-y in a way that fails no arm by itself.
	expect(Number.isFinite(TAP)).toBe(true);
	expect(TAP).toBeGreaterThan(0);
	expect(TAP).toBeGreaterThanOrEqual(TAP_FLOOR);
	// 16px is a WebKit behaviour (a smaller font-size triggers zoom-on-focus), renegotiable only on evidence
	// about WebKit.
	expect(MIN_FIELD_PX).toBe(16);
	// The inset CLAIM 3 simulates has to be big enough to tell a composed term from a bare one.
	expect(SIMULATED_BOTTOM_INSET).toBeGreaterThan(1);
});

test('the gate derives its control set from roles, not from a class allowlist', () => {
	// Caught in `touch-targets.test.ts`: deriving "is this a control?" from a literal class allowlist is how
	// /metrics and lib/charts stayed invisible, so the selector must name roles and element types.
	for (const needed of ['button', 'a[href]', 'select', 'textarea', '[role="button"]']) {
		expect(CONTROL_SELECTOR).toContain(needed);
	}
	// PLAUSIBLE, not merely non-empty: a register trimmed to one clause would sweep a handful of controls and
	// report four claims satisfied over them.
	expect(CONTROL_SELECTOR.split(',').length).toBeGreaterThanOrEqual(5);
	expect(TEXT_INPUT_TYPES).toContain('text');
	// The acceptance names three phone viewports; sweeping one is not the same measurement.
	expect(VIEWPORTS.length).toBeGreaterThanOrEqual(3);
	for (const vp of VIEWPORTS) {
		expect(vp.w, `VIEWPORTS ${vp.name} must have a real width`).toBeGreaterThan(0);
		expect(vp.h, `VIEWPORTS ${vp.name} must have a real height`).toBeGreaterThan(0);
	}
});

test('every non-vacuity floor is a positive number AND is actually asserted by a spec in this directory', () => {
	// A drive that navigates but finds nothing reports every assertion satisfied over an empty set, so a
	// measured gate needs non-vacuity floors as much as a source scan does — and a floor nobody reads is the
	// same vacuum one step removed. The deleted guard asserted this against the single old gate file; here the
	// claims are one spec each, so the scan is over this directory.
	const specs = readdirSync(HERE)
		.filter((f) => f.endsWith('.spec.ts'))
		.map((f) => readFileSync(join(HERE, f), 'utf8'))
		.join('\n');
	for (const [name, min] of Object.entries(FLOORS)) {
		expect(min, `FLOORS.${name} must be a positive floor`).toBeGreaterThan(0);
		expect(specs, `some spec under specs/gate/ must actually assert FLOORS.${name}`).toContain(`FLOORS.${name}`);
	}
	expect(Object.keys(FLOORS).length).toBeGreaterThanOrEqual(4);
});
