import { expect, it } from 'bun:test';
import { cookStageLabel } from './cook-phrasing';

it('cookStageLabel: says the guest word for a finished cook', () => {
	expect(cookStageLabel('ready')).toBe('Karaoke ready');
});

it('cookStageLabel: collapses every in-flight worker state to one "making karaoke" line', () => {
	// The whole point of the helper: separating/aligning are worker steps, not guest words.
	for (const s of ['queued', 'downloading', 'separating', 'aligning'] as const) {
		expect(cookStageLabel(s)).toBe('Making karaoke…');
	}
});

it('cookStageLabel: appends percent when given', () => {
	expect(cookStageLabel('separating', { pct: 68 })).toBe('Making karaoke… 68%');
});

it('cookStageLabel: never leaks the musician vocabulary a guest found confusing', () => {
	for (const s of ['queued', 'downloading', 'separating', 'aligning', 'ready', 'failed'] as const) {
		const line = cookStageLabel(s, { pct: 40 }).toLowerCase();
		expect(line).not.toContain('vocal');
		expect(line).not.toContain('instrumental');
		expect(line).not.toContain('separat');
		expect(line).not.toContain('align');
	}
});

it('cookStageLabel: is honest about failure', () => {
	expect(cookStageLabel('failed')).toBe("Couldn't make karaoke");
});
