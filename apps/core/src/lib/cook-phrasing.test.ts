import { describe, expect, it } from 'bun:test';
import { cookStageChipLabel, cookStageLabel } from './cook-phrasing';

describe('cookStageLabel', () => {
	it('says the guest word for a finished cook', () => {
		expect(cookStageLabel('ready')).toBe('Karaoke ready');
	});

	it('collapses every in-flight worker state to one "making karaoke" line', () => {
		// The whole point of the helper: separating/aligning are worker steps, not guest words.
		for (const s of ['queued', 'downloading', 'separating', 'aligning'] as const) {
			expect(cookStageLabel(s)).toBe('Making karaoke…');
		}
	});

	it('appends percent and ETA when given, in that order', () => {
		expect(cookStageLabel('separating', { pct: 68 })).toBe('Making karaoke… 68%');
		expect(cookStageLabel('separating', { pct: 68, etaSec: 90 })).toBe('Making karaoke… 68% · ~2 min left');
	});

	it('rounds ETA up to at least one minute and drops a non-positive ETA', () => {
		expect(cookStageLabel('separating', { pct: 10, etaSec: 20 })).toBe('Making karaoke… 10% · ~1 min left');
		expect(cookStageLabel('separating', { pct: 10, etaSec: 0 })).toBe('Making karaoke… 10%');
	});

	it('never leaks the musician vocabulary a guest found confusing', () => {
		for (const s of ['queued', 'downloading', 'separating', 'aligning', 'ready', 'failed'] as const) {
			const line = cookStageLabel(s, { pct: 40, etaSec: 60 }).toLowerCase();
			expect(line).not.toContain('vocal');
			expect(line).not.toContain('instrumental');
			expect(line).not.toContain('separat');
			expect(line).not.toContain('align');
		}
	});

	it('is honest about failure', () => {
		expect(cookStageLabel('failed')).toBe("Couldn't make karaoke");
	});
});

describe('cookStageChipLabel', () => {
	it('maps each worker state to a plain-English milestone', () => {
		expect(cookStageChipLabel('queued')).toBe('Queued');
		expect(cookStageChipLabel('downloading')).toBe('Fetched');
		expect(cookStageChipLabel('separating')).toBe('Making karaoke');
		expect(cookStageChipLabel('aligning')).toBe('Adding lyrics');
		expect(cookStageChipLabel('ready')).toBe('Ready');
		expect(cookStageChipLabel('failed')).toBe('Failed');
	});

	it('keeps the musician/worker words out of the chip labels too', () => {
		// "lyrics" is a guest word and stays ("Adding lyrics"); the jargon to avoid is the worker's
		// step names and the musician's stem words.
		for (const s of ['queued', 'downloading', 'separating', 'aligning', 'ready', 'failed'] as const) {
			const label = cookStageChipLabel(s).toLowerCase();
			expect(label).not.toContain('vocal');
			expect(label).not.toContain('instrumental');
			expect(label).not.toContain('separat');
			expect(label).not.toContain('align');
		}
	});
});
