// guard: a process PROGRESS BAR must scale by OVERALL process completion, not the current step's own pct.
//
// THE DEFECT (#80, the second surface of #51). `overallProcessPct(status, pct)` in @encore/shared
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

// import.meta.dir === apps/core/src/lib.
const COMPONENTS = join(import.meta.dir, 'components');

// Every component that renders a process progress bar. Both MUST route the bar's fill through
// overallProcessPct, never the raw per-step pct. Add a component here when it grows a process bar.
const PROCESS_BAR_COMPONENTS = ['SongRow.svelte', 'ProcessingCard.svelte'];

// The banned form: a process bar scaling directly by the worker's per-step `pct`. `overall / 100`,
// `barPct / 100` (a value already run through overallProcessPct) and `guidePct / 100` (not a process bar) are
// all fine — only the literal per-step `pct` divided by 100 in a transform is the bug.
const RAW_PER_STEP_BAR = /scaleX\(\s*\{?\s*pct\s*\/\s*100\s*\}?\s*\)/;

test('no process-bar component scales its fill by the raw per-step pct (#80)', () => {
	const offenders: string[] = [];
	for (const name of PROCESS_BAR_COMPONENTS) {
		const src = readFileSync(join(COMPONENTS, name), 'utf8');
		if (RAW_PER_STEP_BAR.test(src)) offenders.push(name);
	}
	expect(
		offenders,
		`these process-bar components still render scaleX(pct / 100) — route the bar through ` +
			`overallProcessPct(status, pct) instead so it reads overall process completion (#80): ${offenders.join(', ')}`
	).toEqual([]);
});

test('SongRow derives its process bar from overallProcessPct (#80)', () => {
	const src = readFileSync(join(COMPONENTS, 'SongRow.svelte'), 'utf8');
	// It must import the shared helper …
	expect(src).toContain('overallProcessPct');
	// … and actually feed the helper's output into the bar's scaleX, not the raw pct.
	expect(src).toMatch(/const\s+barPct\s*=\s*\$derived\(.*overallProcessPct/);
	/*
	 * #913 S6: the bar is <Progress value={barPct}>, so the helper's output is handed over as a value
	 * rather than baked into a scaleX at the call site. The claim is the same and still the point: the
	 * BAR takes the unrounded float — Progress translates by it, so a smooth fill needs the precision —
	 * and only the guest-facing readout rounds, or it prints "31.200000000000003%" (#80).
	 */
	expect(src).toMatch(/<Progress\s+value=\{barPct\}/);
	// … and ROUND barPct where it feeds the guest-facing readout. overallProcessPct returns a
	// band-interpolated float, so an unrounded readout prints "31.200000000000003%" (#80). The bar
	// scaleX stays unrounded (asserted above) for a smooth transition; only the label rounds. This
	// pins the COMPONENT's own composition — a value test on the helpers would round itself and pass
	// with this hunk reverted, so it must scan SongRow's source, matching ProcessingCard's convention.
	expect(src).toMatch(/processStageLabel\('queued',\s*\{\s*pct:\s*Math\.round\(barPct\)/);
});

// The CALLER side of the same wiring. SongRow only reads overall process completion when its parent
// passes the live `status`; a call site that passes `pct=` but drops `status=` silently falls back to
// the raw per-step pct — the #80 bug, fully restored, with the callee still compliant. pr-bot showed
// the earlier guard passed 2/2 even after all four `status=` props were dropped from +page.svelte, so
// the guard must cover the caller too. Scan every <SongRow …> element and require: if it passes pct=,
// it passes status=. This is the repo's most-repeated defect shape (a caller that stops calling).
test('every +page.svelte SongRow that passes pct also passes status (#80)', () => {
	const src = readFileSync(join(import.meta.dir, '..', 'routes', '+page.svelte'), 'utf8');
	// Each <SongRow …> element, self-closing or not, across newlines.
	const elements = src.match(/<SongRow\b[\s\S]*?\/?>/g) ?? [];
	expect(elements.length, 'expected to find <SongRow> usages in +page.svelte').toBeGreaterThan(0);
	const offenders = elements.filter((el) => /\bpct=/.test(el) && !/\bstatus=/.test(el));
	expect(
		offenders,
		`these +page.svelte <SongRow> call sites pass pct= but not status=, so barPct falls back to the ` +
			`raw per-step pct and re-opens #80. Add status={…} beside pct=:\n${offenders.join('\n---\n')}`
	).toEqual([]);
});
