import { describe, expect, it } from 'bun:test';
import {
	ASR_MODELS,
	SYNC_MODES,
	DEFAULT_ASR_MODEL,
	DEFAULT_SYNC_MODE,
	getAsrModel,
	getSyncMode,
	isValidAsrModel,
	isValidSyncMode,
	DEFAULT_GLOBAL_SETTINGS,
	normalizeGlobalSettings
} from '../index';

describe('ASR model registry', () => {
	it('defaults to the value the worker hardcoded, so exposing the setting changes no behaviour', () => {
		// If this ever needs changing, it is a deliberate behaviour change to every existing deployment
		// and belongs in a migration note — not a quiet default bump.
		expect(DEFAULT_ASR_MODEL).toBe('base');
		expect(isValidAsrModel(DEFAULT_ASR_MODEL)).toBe(true);
	});

	it('states a tradeoff for every model, so a picker can never offer an unexplained choice', () => {
		for (const m of ASR_MODELS) {
			expect(m.label.length).toBeGreaterThan(0);
			expect(m.note.length).toBeGreaterThan(0);
			expect(m.params).toMatch(/^\d+M$/);
		}
	});

	it('rejects tokens that would fail at model load rather than passing them through', () => {
		// The failure this prevents is silent: an unknown token reaches whisperx.load_model(), which
		// tries to resolve it as a HuggingFace repo, and AsrSource swallows the exception — so the tier
		// declines and the song finishes with no words and no stated reason.
		expect(isValidAsrModel('large')).toBe(false); // ambiguous: v1/v2/v3 all exist
		expect(isValidAsrModel('base.en')).toBe(false); // deliberately not whitelisted
		expect(getAsrModel('nope')).toBeUndefined();
	});
});

describe('sync mode registry', () => {
	it('defaults to forced alignment — the only mode that can highlight words', () => {
		expect(DEFAULT_SYNC_MODE).toBe('forced');
		expect(getSyncMode('forced')?.granularity).toBe('word');
		expect(getSyncMode('forced')?.usesAligner).toBe(true);
	});

	it('line mode is declared as the one that skips the aligner', () => {
		// This boolean IS the cost model: it is the difference between one ML pass per process and two.
		expect(getSyncMode('lines')?.usesAligner).toBe(false);
		expect(getSyncMode('lines')?.granularity).toBe('line');
	});

	it('rejects an unknown mode', () => {
		expect(isValidSyncMode('word')).toBe(false); // a granularity, not a mode
		expect(SYNC_MODES.every((m) => isValidSyncMode(m.id))).toBe(true);
	});
});

describe('normalizeGlobalSettings with lyrics engines', () => {
	it('carries a valid model and mode through', () => {
		const out = normalizeGlobalSettings({ asrModel: 'small', syncMode: 'lines' });
		expect(out.asrModel).toBe('small');
		expect(out.syncMode).toBe('lines');
	});

	it('degrades a de-whitelisted value to the base instead of persisting it', () => {
		// A checkpoint can be removed between releases; a stored value must then read as the default
		// rather than being served to a worker that would fail on it.
		const out = normalizeGlobalSettings({ asrModel: 'gone', syncMode: 'gone' } as never);
		expect(out.asrModel).toBe(DEFAULT_ASR_MODEL);
		expect(out.syncMode).toBe(DEFAULT_SYNC_MODE);
	});

	it('rejecting one bad field cannot wipe the other valid choice', () => {
		// The whole reason normalize takes a `base`: a partial PUT is a patch, so an invalid model must
		// not silently reset a sync mode the operator set on a previous save.
		const current = { ...DEFAULT_GLOBAL_SETTINGS, asrModel: 'medium' as const, syncMode: 'lines' as const };
		const out = normalizeGlobalSettings({ asrModel: 'bogus' } as never, current);
		expect(out.asrModel).toBe('medium'); // fell back to CURRENT, not to the hardcoded default
		expect(out.syncMode).toBe('lines'); // untouched field survives
	});

	it('an absent field keeps the current value, so a patch of one setting is safe', () => {
		const current = { ...DEFAULT_GLOBAL_SETTINGS, asrModel: 'small' as const };
		expect(normalizeGlobalSettings({ enqueueUpgrade: true }, current).asrModel).toBe('small');
	});
});
