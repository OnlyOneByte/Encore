/**
 * guard: the PROSE gate list and the EXECUTABLE gate list are the same list.
 *
 * ── THE DEFECT THIS EXISTS FOR ─────────────────────────────────────────────────────────────────
 *
 * For most of this repo's life there was no runnable definition of "the gates". `docs/loop/PR-BOT.md`
 * carried them as a `·`-separated line of prose, `docs/loop/pipeline.json` carried a second copy inside
 * a comment string, and every lane assembled the set by hand from whichever file it happened to read.
 * Nothing compared any copy to any other, so all of them drifted — and drifted differently:
 *
 *   - pipeline.json claimed `bun test` ran "1351 tests in ~8s" and pytest "~540 in ~5s". Measured
 *     reality on 2026-09-12 was 2672 in ~33s and 915 in ~105s: wrong by 4x and 20x.
 *   - pipeline.json named FOUR gates. PR-BOT.md named five, but a DIFFERENT five.
 *   - `bun run lint` was in neither list, while being a real blocking check that was itself RED at HEAD
 *     (5 `no-unused-vars` errors) precisely because no gate list mentioned it, so nothing ran it.
 *
 * A prose list is not a gate. `package.json`'s `gates` script is now the single executable definition,
 * and this file is the thing that makes the documentation follow it instead of narrating it: it parses
 * the legs out of the script, out of the PR-BOT.md line, and out of pipeline.json's `gates.legs`, and
 * reds unless all three are the SAME legs in the SAME order.
 *
 * ── WHY ORDER, NOT JUST MEMBERSHIP ────────────────────────────────────────────────────────────
 *
 * The task these came from asked for set equality. Ordered equality is asserted instead because the
 * order is load-bearing and free to check: the script stops at the first failing leg, so a lane told
 * to run `build` before `typecheck` gets a different (and slower) first failure than the script gives.
 * Comparing arrays also produces a failure message that names WHICH leg moved, where a set diff would
 * only say the sets differ.
 *
 * ── WHY A TEXT SCAN IS THE RIGHT RUNG HERE ────────────────────────────────────────────────────
 *
 * The subject IS text. What can go wrong is a documented list disagreeing with a declared list, and
 * both are decidable from source on any box with no browser, no server and no Python — so this belongs
 * in `bun test`, where it runs on every head, rather than in an e2e rung that can skip.
 */
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

/** The script in the root `package.json` that IS the gate definition. */
const SCRIPT = 'gates';

/** The brief whose prose list must match it. */
const PROSE_DOC = 'docs/loop/PR-BOT.md';

/** The pipeline config that carries a third, machine-readable copy. */
const PIPELINE = 'docs/loop/pipeline.json';

/**
 * The test leg, in either spelling. `bun run test` is now the canonical form — the script it delegates
 * to carries `--conditions=svelte`, which bun's test resolver needs because `vaul-svelte`'s exports map
 * declares only `types` and `svelte` with no `default` condition, and bunfig.toml was measured to ignore
 * a `conditions` key (top level and under `[test]`) on bun 1.3.14. Putting the flag in the script means
 * it is declared ONCE instead of at every call site. The older bare `bun test` is still accepted so this
 * guard keeps working from either side of that move rather than reporting "no test leg found".
 */
const TEST_LEG = /\bbun (?:run )?test\b/;

/**
 * Parse the legs out of the `gates` script.
 *
 * The script is a `;`-separated sh chain where every LEG carries a `|| { echo …; exit 1; }` failure
 * arm — that arm is what makes the chain stop at the first failure and name it, so requiring it is
 * not incidental parsing convenience: a statement without one is not a gate, because it cannot fail
 * the run. The trailing `echo 'gates: all 6 legs green'` has no arm and is therefore correctly
 * excluded rather than special-cased by its text.
 */
function legsFromScript(script: string): string[] {
	const legs: string[] = [];
	for (const stmt of script.split(';')) {
		const idx = stmt.indexOf('||');
		if (idx === -1) continue;
		let cmd = stmt.slice(0, idx).trim();
		// A leg that needs its own working directory is wrapped in a subshell so the `cd` cannot leak
		// into the legs after it. The parentheses are shell mechanics, not part of the command.
		if (cmd.startsWith('(') && cmd.endsWith(')')) cmd = cmd.slice(1, -1).trim();
		if (cmd) legs.push(cmd);
	}
	return legs;
}

/**
 * Parse the legs out of the prose line in PR-BOT.md.
 *
 * The line is identified STRUCTURALLY — the unique line containing `·`-separated commands that starts
 * with the test leg — rather than by line number. A line number in a guard is a stale pointer waiting
 * to happen: this very list has already moved down the file once. The spelling is matched loosely
 * (`bun test` OR `bun run test`, see `TEST_LEG`) because the leg moved from the former to the latter;
 * pinning either one alone would make this finder return zero lines the next time it moves. Uniqueness
 * is asserted below, so a second such line is a finding instead of a silently-preferred first match.
 */
function proseLines(doc: string): string[] {
	return doc
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.startsWith('bun') && TEST_LEG.test(l) && l.includes('·'));
}

function legsFromProse(line: string): string[] {
	return line
		.split('·')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
const script = pkg.scripts?.[SCRIPT];
const doc = read(PROSE_DOC);
const pipeline = JSON.parse(read(PIPELINE)) as { gates?: { legs?: string[]; command?: string } };

test(`the root package.json declares a \`${SCRIPT}\` script`, () => {
	// Nothing below can mean anything if the executable definition is absent, and its absence is
	// exactly the state this whole guard was written to end.
	expect(script, `package.json must declare a \`${SCRIPT}\` script — it is the gate definition`).toBeString();
});

test('the prose gate list appears exactly once, so the guard cannot be reading the wrong line', () => {
	const found = proseLines(doc);
	expect(
		found.length,
		`${PROSE_DOC} must carry exactly ONE \`·\`-separated gate list line; found ${found.length}. ` +
			`Two copies is the drift this guard exists to prevent, and zero means the list moved or changed shape.`
	).toBe(1);
});

test('the PROSE gate list names exactly the legs the `gates` script runs, in the same order', () => {
	const scriptLegs = legsFromScript(script!);
	const prose = legsFromProse(proseLines(doc)[0]!);

	// Ordered equality: the script stops at the first failure, so leg ORDER changes which failure a
	// lane sees first. `toEqual` on arrays also names the leg that moved.
	expect(
		prose,
		`${PROSE_DOC}'s gate list disagrees with package.json's \`${SCRIPT}\` script. ` +
			`Change the script, then make the prose follow it — never the other way round.`
	).toEqual(scriptLegs);

	// Non-vacuity: a broken `legsFromScript` regex, an emptied script, or a prose line that stopped
	// matching the shape would compare [] to [] and pass while enforcing nothing — the exact silent
	// green this file exists to prevent, one level up.
	//
	// SEVEN legs, and the seventh is the sharpest instance of this file's own thesis. `bun run gate:measured`
	// was documented as deliberately OUTSIDE the chain ("needs a build and a browser, so it is not a leg"),
	// and while it sat outside, the join screen became two panes, its driver's `fill(SEL.nameInput)` started
	// timing out on the first pane, and the gate stopped running at all — silently, taking the four
	// measured claims (hit extents, field font size, --dock-h, the focus ring) with it. A guard nobody runs
	// is the same hole `bun run lint` and `format:check` each fell through before it, which is why both of
	// them are legs today. So it is leg 7 rather than a footnote.
	expect(scriptLegs.length, 'the leg parse found nothing — the script shape changed').toBeGreaterThanOrEqual(7); // @nvf-floor scriptLegs.length
});

test('pipeline.json’s machine-readable `gates.legs` is the same list too', () => {
	// pipeline.json is the file that drifted WORST — four gates and two invented durations — and it is
	// the one a conductor reads programmatically, so leaving it unpinned would mean correcting it once
	// and watching it rot again with nobody comparing it to anything.
	const scriptLegs = legsFromScript(script!);
	expect(
		pipeline.gates?.legs,
		`${PIPELINE} gates.legs must mirror package.json's \`${SCRIPT}\` script leg-for-leg`
	).toEqual(scriptLegs);
	// …and it must point at the runnable command rather than restating the legs as its own recipe.
	expect(pipeline.gates?.command).toBe(`bun run ${SCRIPT}`);
});

test('every leg is a real, runnable command — not a description of one', () => {
	// A leg is only executable if it is a command. This arm is what stops the list degrading back into
	// prose one entry at a time (`run the tests`, `the type gate`), which is how the previous list read
	// in three of the five briefs.
	const offenders: string[] = [];
	for (const leg of legsFromScript(script!)) {
		if (!/^(bun|cd)\b/.test(leg)) offenders.push(`${JSON.stringify(leg)}: does not start with \`bun\` or \`cd\``);
		if (/^bun run /.test(leg)) {
			const name = leg.slice('bun run '.length).trim();
			if (!pkg.scripts?.[name]) offenders.push(`${JSON.stringify(leg)}: package.json declares no \`${name}\` script`);
		}
	}
	expect(offenders).toEqual([]);
});

test('the test leg runs from the repo root, where bunfig.toml’s relative preload resolves', () => {
	// bun does NOT walk up for bunfig.toml, and this repo's preload path is relative, so a test run
	// from a subdirectory silently loses the DOM/Svelte preload and reports ~44 phantom failures.
	// The leg must therefore be the BARE test command with no `cd` in front of it, and only the pytest
	// leg may carry a `cd` — that, not the leg's spelling, is what this arm is pinning.
	//
	// The canonical spelling is now `bun run test`, not `bun test`: the `test` script carries
	// `--conditions=svelte` so the flag is declared ONCE rather than at every call site (bun's test
	// resolver needs it for `vaul-svelte`, whose exports map has no `default` condition, and bunfig.toml
	// was measured to ignore a `conditions` key). Both spellings are accepted via `TEST_LEG` so the leg
	// can move between them without this guard reporting a phantom "no test leg found"; what stays
	// asserted is that whichever spelling is used, it is the WHOLE leg — nothing before it, nothing
	// after it, so no working directory can be changed out from under it.
	const legs = legsFromScript(script!);
	const testLeg = legs.find((l) => TEST_LEG.test(l));
	expect(testLeg, 'no `bun test` / `bun run test` leg found').toBeString();
	expect(
		testLeg,
		'the test leg must run from the repo root — anything wrapped around bare `bun test` / `bun run test` (a `cd`, a prefix) loses bunfig.toml'
	).toMatch(/^bun (?:run )?test$/);
	// The pytest leg is the ONE leg allowed to change directory, and it must come back (it is wrapped
	// in a subshell in the script, which `legsFromScript` strips — so assert the `cd` is scoped there).
	const cdLegs = legs.filter((l) => /(^|\s)cd\s/.test(l));
	expect(cdLegs).toEqual(['cd worker && python3 -m pytest -q']);
});

test('the script fails closed: every leg names itself on failure and exits non-zero', () => {
	// The task these came from required the script to "exit non-zero if any leg fails and print which
	// leg failed". An `&&` chain would satisfy the first half and silently drop the second, so this
	// pins both: one failure arm per leg, each carrying a non-zero `exit` and the leg's own name.
	const legs = legsFromScript(script!);
	const arms = [...script!.matchAll(/\|\|\s*\{([^}]*)\}/g)].map((m) => m[1]!);
	expect(arms.length, 'every leg must carry its own `|| { echo …; exit 1; }` arm').toBe(legs.length);
	const offenders: string[] = [];
	arms.forEach((arm, i) => {
		const leg = legs[i]!;
		if (!/\bexit\s+[1-9]/.test(arm)) offenders.push(`leg ${i + 1} (${leg}): failure arm does not exit non-zero`);
		if (!arm.includes('echo')) offenders.push(`leg ${i + 1} (${leg}): failure arm prints nothing`);
		// The arm must name ITS OWN leg, or the run reports the wrong failing gate — which is worse
		// than reporting none, because it sends the reader to a green leg.
		if (!arm.includes(leg)) offenders.push(`leg ${i + 1}: failure arm does not name the leg (${JSON.stringify(leg)})`);
	});
	expect(offenders).toEqual([]);
});
