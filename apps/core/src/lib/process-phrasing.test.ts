import { describe, expect, it } from 'bun:test';
import { processStageLabel } from './process-phrasing';

describe('processStageLabel', () => {
	it('says the guest word for a finished process', () => {
		expect(processStageLabel('ready')).toBe('Karaoke ready');
	});

	it('collapses every in-flight worker state to one "making karaoke" line', () => {
		// The whole point of the helper: separating/aligning are worker steps, not guest words.
		for (const s of ['queued', 'downloading', 'separating', 'aligning'] as const) {
			expect(processStageLabel(s)).toBe('Making karaoke…');
		}
	});

	it('appends percent when given', () => {
		expect(processStageLabel('separating', { pct: 68 })).toBe('Making karaoke… 68%');
	});

	it('never leaks the musician vocabulary a guest found confusing', () => {
		for (const s of ['queued', 'downloading', 'separating', 'aligning', 'ready', 'failed'] as const) {
			const line = processStageLabel(s, { pct: 40 }).toLowerCase();
			expect(line).not.toContain('vocal');
			expect(line).not.toContain('instrumental');
			expect(line).not.toContain('separat');
			expect(line).not.toContain('align');
		}
	});

	it('is honest about failure', () => {
		expect(processStageLabel('failed')).toBe("Couldn't make karaoke");
	});
});
