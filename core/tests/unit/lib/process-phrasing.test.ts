import { describe, expect, it } from 'bun:test';
import { processReadout, processStageLabel } from '$lib/phrasing/process-phrasing';

describe('processReadout', () => {
	it('shows the real percentage and the time', () => {
		expect(processReadout(64.4, 55, 130)).toBe('64% · ~2 min');
		expect(processReadout(64, 55, 20)).toBe('64% · under a minute');
	});

	it('says only the time while the engine has reported no figure of its own', () => {
		// The bar keeps the stage floor (20%); printing it would read as a measurement.
		expect(processReadout(20, 0, 130)).toBe('~2 min');
	});

	it('says nothing it has no basis for', () => {
		expect(processReadout(64, 55)).toBe('64%');
		expect(processReadout(20, 0, null)).toBe('');
	});

	it('says it is taking longer once the estimate is overrun, instead of "under a minute" forever', () => {
		expect(processReadout(64, 55, -1)).toBe('Taking longer than usual');
		expect(processReadout(20, 0, -1)).toBe('Taking longer than usual');
	});
});

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
