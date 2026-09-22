// guard: a process PROGRESS BAR must scale by OVERALL process completion, not the current step's own pct.
//
// THE DEFECT (the second surface of an earlier change). `overallProcessPct(status, pct)` in $lib/contract
// maps the worker's per-step 0-100 into weighted per-stage bands over MEDIA_STAGES, so a bar reads how
// far through the whole process a song is — reaching 100% only at `ready` and never jumping backward when
// the next step resets its own pct. That function was written and unit-proven for ProcessingCard, but
// SongRow's Processing-group bar still scaled the whole bar by the raw per-step `pct`: every step that hit
// 100% filled the bar while later milestones had not started, and a step reset (separating 0 after
// downloading 100) ran the bar full -> empty while the process moved FORWARD. The pure function was right;
// it simply was not wired into the second surface — this repo's most-repeated defect class (a
// mechanism built, tested, and never called from the path that needs it).
//
// WHY A SOURCE SCAN. The wrong wiring is a property of the component source (a `scaleX(pct / 100)`
// literal on a process bar), so it is decidable without rendering. The guard reads the two components that
// draw a process bar and forbids the raw-per-step form; the fix is the non-test caller that satisfies it.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { at, filesUnder, relative } from '@encore/test-support';

// Named absolutely. This used to be `at('src/lib/components')` — "the components
// directory next to me", which only meant src/lib/components while this test sat in lib/.
const COMPONENTS = at('src/lib/components');

// Every component that renders a process progress bar. Both MUST route the bar's fill through
// overallProcessPct, never the raw per-step pct. Add a component here when it grows a process bar.
const PROCESS_BAR_COMPONENTS = ['SongRow.svelte', 'ProcessingCard.svelte'];

// The banned form: a process bar scaling directly by the worker's per-step `pct`. `overall / 100`,
// `barPct / 100` (a value already run through overallProcessPct) and `guidePct / 100` (not a process bar) are
// all fine — only the literal per-step `pct` divided by 100 in a transform is the bug.
const RAW_PER_STEP_BAR = /scaleX\(\s*\{?\s*pct\s*\/\s*100\s*\}?\s*\)/;

test('no process-bar component scales its fill by the raw per-step pct', () => {
	const offenders: string[] = [];
	for (const name of PROCESS_BAR_COMPONENTS) {
		const src = readFileSync(join(COMPONENTS, name), 'utf8');
		if (RAW_PER_STEP_BAR.test(src)) offenders.push(name);
	}
	expect(
		offenders,
		`these process-bar components still render scaleX(pct / 100) — route the bar through ` +
			`overallProcessPct(status, pct) instead so it reads overall process completion: ${offenders.join(', ')}`
	).toEqual([]);
});

test('SongRow derives its process bar from overallProcessPct', () => {
	const src = readFileSync(join(COMPONENTS, 'SongRow.svelte'), 'utf8');
	// It must import the shared helper …
	expect(src).toContain('overallProcessPct');
	// … and actually feed the helper's output into the bar's scaleX, not the raw pct.
	expect(src).toMatch(/const\s+barPct\s*=\s*\$derived\(.*overallProcessPct/);
	/*
	 * S6: the bar is <Progress value={barPct}>, so the helper's output is handed over as a value
	 * rather than baked into a scaleX at the call site. The claim is the same and still the point: the
	 * BAR takes the unrounded float — Progress translates by it, so a smooth fill needs the precision —
	 * and only the guest-facing readout rounds, or it prints "31.200000000000003%".
	 */
	expect(src).toMatch(/<Progress\s+value=\{barPct\}/);
	// … and ROUND barPct where it feeds the guest-facing readout. overallProcessPct returns a
	// band-interpolated float, so an unrounded readout prints "31.200000000000003%". The bar
	// scaleX stays unrounded (asserted above) for a smooth transition; only the label rounds. This
	// pins the COMPONENT's own composition — a value test on the helpers would round itself and pass
	// with this hunk reverted, so it must scan SongRow's source, matching ProcessingCard's convention.
	expect(src).toMatch(/processStageLabel\('queued',\s*\{\s*pct:\s*Math\.round\(barPct\)/);
});

// The CALLER side of the same wiring. SongRow only reads overall process completion when its parent
// passes the live `status`; a call site that passes `pct=` but drops `status=` silently falls back to
// the raw per-step pct — the bug, fully restored, with the callee still compliant. pr-bot showed
// the earlier guard passed 2/2 even after all four `status=` props were dropped from the page, so
// the guard must cover the caller too. Scan every <SongRow …> element and require: if it passes pct=,
// it passes status=. This is the repo's most-repeated defect shape (a caller that stops calling).
//
// RE-POINTED AS A WALK, not at a second single path. This arm used to name `src/routes/+page.svelte`,
// which was the only page rendering a SongRow; the phone-remote redesign moved every SongRow off home onto
// `routes/find/+page.svelte`, and naming that file instead would just have relocated the same blind spot —
// the NEXT route to grow a song list would be unguarded exactly as /find was on the day it was created. The
// walk is why the merge back onto home (2026-09-22) cost this file nothing at all. So the population is now derived: every `+page.svelte` under `src/routes`
// that renders a SongRow, with a non-vacuity floor on both the page count and the element count so a
// tree that stops rendering SongRow anywhere reds instead of reporting green over nothing.
//
// `routes/components` — the eyes-on component gallery — is EXCLUDED, and that is the one judgement in
// this arm. It is a fixture surface whose job is to render states side by side, including the
// un-decorated `pct` WITHOUT a `status` that is this guard's offender shape: two of its rows carry a
// commented-in-source instruction that they omit the status deliberately ("A row without a status is
// unchanged — it still shows the raw pct"), because seeing the raw-pct bar beside the overall-pct bar
// is how a human confirms the fix landed. The invariant being guarded is about the RENDER PATH a guest
// actually reaches, not about a demo of the bug. Scope is still strictly wider than before this
// re-point (home plus /find plus every future route, versus home alone).
const FIXTURE_PAGES = ['src/routes/components/+page.svelte'];

test('every route page SongRow that passes pct also passes status', () => {
	const excluded = FIXTURE_PAGES.map((p) => at(p));
	const pages = filesUnder('src/routes', ['.svelte'])
		.filter((p) => p.endsWith('+page.svelte') && !excluded.includes(p))
		.map((p) => ({ path: p, src: readFileSync(p, 'utf8') }))
		.filter((p) => /<SongRow\b/.test(p.src));
	expect(
		pages.length,
		'expected at least one non-fixture +page.svelte under src/routes to render <SongRow>'
	).toBeGreaterThan(0);
	const offenders: string[] = [];
	let elementCount = 0;
	for (const page of pages) {
		// Each <SongRow …> element, self-closing or not, across newlines.
		const elements = page.src.match(/<SongRow\b[\s\S]*?\/?>/g) ?? [];
		elementCount += elements.length;
		for (const el of elements) {
			if (/\bpct=/.test(el) && !/\bstatus=/.test(el)) offenders.push(`${relative(page.path)}:\n${el}`);
		}
	}
	expect(elementCount, 'expected to find <SongRow> usages on the pages that reference it').toBeGreaterThan(0);
	expect(
		offenders,
		`these <SongRow> call sites pass pct= but not status=, so barPct falls back to the ` +
			`raw per-step pct and re-opens the process-bar defect. Add status={…} beside pct=:\n${offenders.join('\n---\n')}`
	).toEqual([]);
});
