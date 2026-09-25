// Diff two preflight-reset-audit runs.
//
// Elements pair BY INDEX in document order, sound only while both runs rendered the same DOM — and several
// surfaces are DATA-DEPENDENT. So a surface is compared only when its full TAG SEQUENCE matches, and one whose
// sequence differs is reported NOT-COMPARABLE with its counts, never quietly either way.
//
// THIS IS A UNIT TEST, AND IT BELONGS IN tests/unit/ — SAYING SO RATHER THAN DROPPING IT. The original is a
// CLI over two JSON files (`preflight-diff.mjs <before.json> <after.json>`): it opens no browser, reaches no
// server, and touches no DOM. Its one assertion is its exit code — `styleDiffs + rectDiffs === 0` — evaluated
// over whatever two files a human hands it, which in the workflow are captures taken either side of a CSS
// change. Playwright cannot supply that pair: a single run has only one version of the stylesheet, so the
// before/after the tool exists to compare does not exist inside one test. What CAN be moved here is the
// function and every branch of the comparability gate the old file's header is entirely about, exercised
// against fixtures. Note that no test below takes the `world` fixture, so no core boots for this file at all —
// which is the plainest evidence available that it is not an end-to-end spec.
//
// If the repo wants this properly placed, the move is: lift `diffRuns` into a module under src/ or tests/, and
// re-file these four tests under tests/unit/. Nothing here depends on Playwright beyond `test`/`expect`.
import { test, expect } from '../../world/fixtures';

/** A rect component must move by more than this to count as a moved box. */
const PX_EPSILON = 0.01;

// Tags that render nothing. Preflight's universal rules reach them too, so an unfiltered tally counts
// `tab-size` on every `<meta>` and reads as a far larger change than the screen sustains. Counted SEPARATELY
// rather than dropped.
const INERT_TAGS = new Set(['html', 'head', 'meta', 'link', 'title', 'script', 'style', 'base']);

interface Row {
	tag: string;
	cls?: string;
	rect: number[];
	s: Record<string, string>;
}
interface SurfaceEntry {
	count?: number;
	els?: Row[];
	error?: string;
}
interface Run {
	surfaces: Record<string, SurfaceEntry>;
}

interface DiffReport {
	/** Surfaces whose element population matched, so pairing by index is sound. */
	comparable: number;
	/** Differing computed values over every paired element, inert `<head>` nodes included. */
	styleDiffs: number;
	/** The same count over RENDERED elements only — what the screen can actually show. */
	styleDiffsRendered: number;
	/** Elements whose box moved on any of x/y/w/h. One per element, not per component. */
	rectDiffs: number;
	/** Every surface that could NOT be paired, with its reason. Reported, never skipped. */
	notComparable: string[];
	/** Rendered-element differences by property, most frequent first. */
	propTally: Map<string, number>;
	samples: string[];
	/** The CLI's exit code: 0 when nothing moved and nothing recomputed. */
	exitCode: number;
}

/** The CLI's body, unchanged in behaviour: same gate order, same counters, same 40-sample cap. */
function diffRuns(before: Run, after: Run): DiffReport {
	let comparable = 0;
	let styleDiffs = 0;
	let styleDiffsRendered = 0;
	let rectDiffs = 0;
	const notComparable: string[] = [];
	const propTally = new Map<string, number>();
	const samples: string[] = [];

	for (const name of Object.keys(before.surfaces)) {
		const b = before.surfaces[name];
		const a = after.surfaces[name];
		if (!b) continue;
		if (!a) {
			notComparable.push(`${name}: absent from the after run`);
			continue;
		}
		if (b.error || a.error) {
			notComparable.push(`${name}: probe error (before=${b.error ?? '-'} after=${a.error ?? '-'})`);
			continue;
		}
		if (b.count !== a.count) {
			notComparable.push(`${name}: element count ${b.count} -> ${a.count} (data-dependent surface)`);
			continue;
		}
		const elsB = b.els ?? [];
		const elsA = a.els ?? [];
		const tagsB = elsB.map((e) => e.tag).join(',');
		const tagsA = elsA.map((e) => e.tag).join(',');
		if (tagsB !== tagsA) {
			notComparable.push(`${name}: same count (${b.count}) but the tag sequence differs`);
			continue;
		}

		comparable++;
		for (let i = 0; i < elsB.length; i++) {
			const eb = elsB[i];
			const ea = elsA[i];
			if (!eb || !ea) continue;
			const rendered = !INERT_TAGS.has(eb.tag);
			for (const p of Object.keys(eb.s)) {
				if (eb.s[p] === ea.s[p]) continue;
				styleDiffs++;
				if (!rendered) continue;
				styleDiffsRendered++;
				propTally.set(p, (propTally.get(p) ?? 0) + 1);
				if (samples.length < 40) {
					samples.push(
						`${name} [${i}] <${eb.tag}${eb.cls ? ` class="${eb.cls}"` : ''}> ${p}: ${eb.s[p]} -> ${ea.s[p]}`
					);
				}
			}
			for (let k = 0; k < 4; k++) {
				const rb = eb.rect[k] ?? 0;
				const ra = ea.rect[k] ?? 0;
				if (Math.abs(rb - ra) > PX_EPSILON) {
					rectDiffs++;
					break;
				}
			}
		}
	}

	return {
		comparable,
		styleDiffs,
		styleDiffsRendered,
		rectDiffs,
		notComparable,
		propTally,
		samples,
		exitCode: styleDiffs + rectDiffs === 0 ? 0 : 1
	};
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────

/** A capture row with only the properties a case is about; the diff reads whatever keys `s` carries. */
function row(tag: string, s: Record<string, string>, rect: number[] = [0, 0, 100, 20], cls?: string): Row {
	return { tag, cls, rect, s };
}
function surface(els: Row[]): SurfaceEntry {
	return { count: els.length, els };
}
/** A deep copy, so a case mutates the AFTER run without touching the BEFORE it is compared against. */
function clone(run: Run): Run {
	return JSON.parse(JSON.stringify(run)) as Run;
}

/** Two rendered elements and one inert `<head>` node, which is the split the tally exists for. */
const BASE: Run = {
	surfaces: {
		'phone-home': surface([
			row('html', { 'tab-size': '4', 'box-sizing': 'border-box' }, [0, 0, 430, 860]),
			row('meta', { 'tab-size': '4', 'box-sizing': 'border-box' }, [0, 0, 0, 0]),
			row('div', { 'margin-top': '0px', 'box-sizing': 'border-box' }, [0, 0, 430, 48], 'band')
		]),
		tv: surface([
			row('html', { 'tab-size': '4' }, [0, 0, 1920, 1080]),
			row('p', { 'font-size': '16px' }, [10, 20, 300, 24], 'url')
		])
	}
};

// ── the claims ───────────────────────────────────────────────────────────────────────────────────────────

test('two identical runs diff to nothing, which is the tool’s exit 0', async () => {
	const report = diffRuns(BASE, clone(BASE));
	expect(report.comparable, 'both surfaces should have paired').toBe(2);
	expect(report.notComparable).toEqual([]);
	expect(report.styleDiffs).toBe(0);
	expect(report.styleDiffsRendered).toBe(0);
	expect(report.rectDiffs).toBe(0);
	expect(report.exitCode, 'the CLI exits 0 only when styleDiffs + rectDiffs is 0').toBe(0);
});

test('a computed-value change counts against the screen only when the element renders', async () => {
	const after = clone(BASE);
	// One inert <head> node and one rendered element, each with exactly one changed property.
	after.surfaces['phone-home']!.els![1]!.s['tab-size'] = '8';
	after.surfaces['phone-home']!.els![2]!.s['margin-top'] = '8px';

	const report = diffRuns(BASE, after);
	expect(report.styleDiffs, 'both differences are counted, inert nodes included').toBe(2);
	expect(report.styleDiffsRendered, 'only the <div> can show a difference on screen').toBe(1);
	expect(report.rectDiffs, 'no box was declared to have moved').toBe(0);
	expect([...report.propTally.entries()], 'the tally is by property, rendered elements only').toEqual([
		['margin-top', 1]
	]);
	expect(report.samples).toEqual(['phone-home [2] <div class="band"> margin-top: 0px -> 8px']);
	expect(report.exitCode).toBe(1);
});

test('a box counts as moved once, and only past the pixel epsilon', async () => {
	const nudged = clone(BASE);
	// Two components of ONE element's rect, to prove the per-element `break`.
	nudged.surfaces['tv']!.els![1]!.rect = [12, 22, 300, 24];
	const moved = diffRuns(BASE, nudged);
	expect(moved.rectDiffs, 'two changed components of one rect are still one moved box').toBe(1);
	expect(moved.styleDiffs, 'a moved box is not a changed declaration').toBe(0);
	expect(moved.exitCode, 'the margin reset does its damage as a moved box, so it must fail the diff').toBe(1);

	const within = clone(BASE);
	within.surfaces['tv']!.els![1]!.rect = [10.005, 20, 300, 24];
	const settled = diffRuns(BASE, within);
	expect(settled.rectDiffs, `a delta inside ${PX_EPSILON}px is rounding, not a move`).toBe(0);
	expect(settled.exitCode).toBe(0);
});

test('an unpairable surface is REPORTED with its reason, never quietly compared or skipped', async () => {
	const absent = clone(BASE);
	delete absent.surfaces['tv'];
	expect(diffRuns(BASE, absent).notComparable).toEqual(['tv: absent from the after run']);
	expect(diffRuns(BASE, absent).comparable, 'the surviving surface still pairs').toBe(1);

	const errored = clone(BASE);
	errored.surfaces['tv'] = { error: 'redirected to / — join did not take' };
	expect(diffRuns(BASE, errored).notComparable).toEqual([
		'tv: probe error (before=- after=redirected to / — join did not take)'
	]);

	// A data-dependent surface: one more element in the after run, so index pairing is meaningless.
	const grown = clone(BASE);
	grown.surfaces['tv'] = surface([...grown.surfaces['tv']!.els!, row('p', { 'font-size': '16px' })]);
	expect(diffRuns(BASE, grown).notComparable).toEqual(['tv: element count 2 -> 3 (data-dependent surface)']);

	// The same count with a different shape — the case that makes a tag sequence, not a count, the gate.
	const reshaped = clone(BASE);
	reshaped.surfaces['tv']!.els![1] = row('span', { 'font-size': '16px' }, [10, 20, 300, 24], 'url');
	const report = diffRuns(BASE, reshaped);
	expect(report.notComparable).toEqual(['tv: same count (2) but the tag sequence differs']);
	expect(report.styleDiffs, 'nothing from an unpairable surface may reach the tallies').toBe(0);
	expect(report.rectDiffs).toBe(0);
	expect(report.comparable).toBe(1);
});
