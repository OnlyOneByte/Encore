// guard: no comment about `PitchShiftGraph` may name a member the class lacks, and no comment may cite
// pitch-shift.ts by LINE NUMBER — a coordinate drifts the moment a line is inserted above it. Scans comment
// text only (the defect lives there) and asserts it against the CODE surface.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const PITCH = 'src/lib/tv/pitch-shift.ts';
const LIFETIME = 'tests/guards/subsystem-tv/pitch-shift-graph-lifetime.test.ts';
const TVPLAYER = 'src/lib/tv/TvPlayer.svelte';

const pitchSrc = read(PITCH);

// The files whose comments cite pitch-shift.ts. Keep this list and the `SCANNED.length` sentinel in sync if
// another citing file appears.
const SCANNED = [PITCH, LIFETIME, TVPLAYER];

test('arm 1 — every PitchShiftGraph member named in prose exists on the class', () => {
	// Sliced from `export class PitchShiftGraph` so the worklet-STRING class defined above it cannot
	// contribute names.
	const classIdx = pitchSrc.indexOf('export class PitchShiftGraph');
	expect(classIdx).toBeGreaterThan(-1);
	const classBody = pitchSrc.slice(classIdx);
	const memberRe = /^\t(?:async\s+|get\s+)?([a-zA-Z_]\w*)\s*\(/gm;
	const members = new Set<string>();
	for (const m of classBody.matchAll(memberRe)) members.add(m[1]);
	expect(members.size).toBeGreaterThanOrEqual(4);
	expect(members.has('setShift')).toBe(true);
	expect(members.has('detach')).toBe(true);

	// Names prose CLAIMS: lifecycle-list entries plus any `PitchShiftGraph.name`.
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
		const src = read(file);
		const base = file.split('/').pop();
		const commentText = src
			.split('\n')
			.filter((l) => {
				const t = l.trim();
				return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
			})
			.join('\n');
		expect(commentText.length, `${base}: comment text too short — extraction broke`).toBeGreaterThan(80);
		for (const m of commentText.matchAll(new RegExp(re, 'g'))) offenders.push(`${base}: ${m[0]}`);
	}
	expect(SCANNED.length, 'all three citing files must still be scanned').toBe(3);
	expect(offenders, offenders.join(' | ')).toEqual([]);
});
