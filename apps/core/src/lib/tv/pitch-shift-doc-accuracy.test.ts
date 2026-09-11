// — pitch-shift.ts is the most heavily cross-referenced module in the TV tree, and its own
// comments (plus its callers') cite it by coordinate and by identifier. Both idioms rot: a documented
// method can be renamed or never have existed (the lifecycle docstring named a phantom `attach()`),
// and a `pitch-shift.ts:<line>` citation drifts the moment a line is inserted above it. This is the
// untrue-comment / rotted-citation class. This guard makes both machine-checkable.
//
// Comment stripping is INVERTED here, on purpose: the defect lives IN the comments, so stripping them
// would blind the guard to its whole subject — same reasoning doc-accuracy.test.ts states in its header.
// The guard scans comment text only, and asserts it against the CODE surface it is checked against.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// import.meta.dir === apps/core/src/lib/tv.
const TV = import.meta.dir;
const PITCH = join(TV, 'pitch-shift.ts');
const LIFETIME = join(TV, 'pitch-shift-graph-lifetime.test.ts');
const TVPLAYER = join(TV, 'TvPlayer.svelte');

const pitchSrc = readFileSync(PITCH, 'utf8');

// The files whose comments cite pitch-shift.ts. This guard landed in two parts: the first fixed pitch-shift.ts
// and this test file; the second fixed TvPlayer.svelte's two remaining rotted line citations (the deferral
// behind the owner-owned change is now lifted, that change having merged) and ADDED it here. Keep this list and the
// SCANNED.length sentinel in sync if another citing file appears.
const SCANNED = [PITCH, LIFETIME, TVPLAYER];

test('arm 1 — every PitchShiftGraph member named in prose exists on the class', () => {
	// Real member surface: tab-indented declarations after `export class PitchShiftGraph`, so the
	// worklet-string class defined ABOVE cannot contribute names.
	const classIdx = pitchSrc.indexOf('export class PitchShiftGraph');
	expect(classIdx).toBeGreaterThan(-1);
	const classBody = pitchSrc.slice(classIdx);
	const memberRe = /^\t(?:async\s+|get\s+)?([a-zA-Z_]\w*)\s*\(/gm;
	const members = new Set<string>();
	for (const m of classBody.matchAll(memberRe)) members.add(m[1]);
	// Sentinels: extraction must be real.
	expect(members.size).toBeGreaterThanOrEqual(4);
	expect(members.has('setShift')).toBe(true);
	expect(members.has('detach')).toBe(true);

	// Names prose CLAIMS: lifecycle-list entries `^\*   name(` plus any `PitchShiftGraph.name`.
	const named = new Set<string>();
	for (const m of pitchSrc.matchAll(/^\s*\*\s{3,}([a-zA-Z_]\w*)\(/gm)) named.add(m[1]);
	for (const m of pitchSrc.matchAll(/PitchShiftGraph\.([a-zA-Z_]\w*)/g)) named.add(m[1]);
	expect(named.size).toBeGreaterThanOrEqual(2);

	const phantom = [...named].filter((n) => !members.has(n));
	expect(phantom.length, `docs name PitchShiftGraph.${phantom.join('(), ')}() but the class has no such member`).toBe(
		0
	);
});

test('arm 2 — no comment cites pitch-shift.ts by line coordinate', () => {
	const re = /pitch-shift\.ts:(\d+)(?:-(\d+))?/;
	const offenders: string[] = [];
	for (const file of SCANNED) {
		const src = readFileSync(file, 'utf8');
		const base = file.split('/').pop();
		// Comment text only.
		const commentText = src
			.split('\n')
			.filter((l) => {
				const t = l.trim();
				return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
			})
			.join('\n');
		// Sentinel: each file's extracted comment text must be substantial.
		expect(commentText.length, `${base}: comment text too short — extraction broke`).toBeGreaterThan(200);
		for (const m of commentText.matchAll(new RegExp(re, 'g'))) offenders.push(`${base}: ${m[0]}`);
	}
	// Sentinel: all three citing files are scanned (pitch-shift.ts, its lifetime test, and TvPlayer.svelte).
	expect(SCANNED.length).toBe(3);
	expect(offenders, offenders.join(' | ')).toEqual([]);
});
