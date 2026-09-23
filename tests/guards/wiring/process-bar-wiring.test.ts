// A process progress bar must scale by OVERALL process completion — `overallProcessPct(status, pct)`,
// which maps the worker's per-step 0-100 into weighted per-stage bands — never by the raw per-step pct.
// Caught: SongRow scaled by the raw pct, so every step filled the bar while later milestones had not
// started, and a step reset ran the bar full -> empty while the process moved FORWARD.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { at, filesUnder, relative } from '@encore/test-support';

const COMPONENTS = at('src/lib/components');

/** Every component that draws a process bar. Add one here when it grows a process bar. */
const PROCESS_BAR_COMPONENTS = ['SongRow.svelte', 'ProcessingCard.svelte'];

// Deliberately narrow: only the literal per-step `pct` over 100 is the bug. `overall / 100` and
// `barPct / 100` are already run through the helper, and `guidePct / 100` is not a process bar.
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
	expect(src).toContain('overallProcessPct');
	expect(src).toMatch(/const\s+barPct\s*=\s*\$derived\(.*overallProcessPct/);
	expect(src).toMatch(/<Progress\s+value=\{barPct\}/);
	// The LABEL rounds and the scaleX does not: the helper returns a band-interpolated float, so an
	// unrounded readout prints "31.200000000000003%" while an unrounded scaleX keeps the transition
	// smooth. Scanned in the component because a value test on the helper would round itself and pass.
	expect(src).toMatch(/processStageLabel\('queued',\s*\{\s*pct:\s*Math\.round\(barPct\)/);
});

// The CALLER side: SongRow reads overall completion only when its parent passes the live `status`, so a
// site passing `pct=` without `status=` silently falls back to the raw per-step pct — the bug fully
// restored with the callee still compliant. The population is WALKED rather than named, so the next route
// to grow a song list is covered; floors on both page and element counts keep it non-vacuous.
//
// `routes/components` is excluded on purpose: it is the eyes-on gallery, and rendering the un-decorated
// `pct` beside the overall-pct bar is how a human confirms the fix. The invariant is about the render
// path a guest reaches, not about a demo of the bug.
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
