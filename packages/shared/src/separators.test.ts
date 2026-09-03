import { describe, it, expect } from 'bun:test';
import {
	SEPARATOR_ENGINES,
	getEngine,
	isValidSeparator,
	isLiveSelectable,
	normalizeRoomSettings,
	DEFAULT_ROOM_SETTINGS,
	DEFAULT_ENGINE,
	DEFAULT_MODEL
} from './separators';

describe('separator registry', () => {
	it('the live default is a real, live-selectable pairing', () => {
		expect(isValidSeparator(DEFAULT_ENGINE, DEFAULT_MODEL)).toBe(true);
		expect(isLiveSelectable(DEFAULT_ENGINE, DEFAULT_MODEL)).toBe(true);
	});

	it('every engine has at least one model and a distinct capability', () => {
		const caps = new Set<string>();
		for (const e of SEPARATOR_ENGINES) {
			expect(e.models.length).toBeGreaterThan(0);
			expect(caps.has(e.capability)).toBe(false); // capabilities route jobs, so must be unique
			caps.add(e.capability);
		}
	});

	it('rejects unknown engine or unknown model', () => {
		expect(isValidSeparator('nope', 'htdemucs')).toBe(false);
		expect(isValidSeparator('demucs', 'no-such-model')).toBe(false);
	});

	it('ensemble is a real engine but NOT live-selectable (upgrade-only)', () => {
		const ensemble = getEngine('ensemble');
		expect(ensemble).toBeTruthy();
		const model = ensemble!.models[0].id;
		expect(isValidSeparator('ensemble', model)).toBe(true); // valid as an upgrade target
		expect(isLiveSelectable('ensemble', model)).toBe(false); // but never as the live default
	});

	it('demucs whitelist carries the three htdemucs variants', () => {
		const ids = getEngine('demucs')!.models.map((m) => m.id);
		expect(ids).toContain('htdemucs');
		expect(ids).toContain('htdemucs_ft');
		expect(ids).toContain('htdemucs_6s');
	});
});

describe('normalizeRoomSettings', () => {
	it('returns defaults for empty/nullish input', () => {
		expect(normalizeRoomSettings(undefined)).toEqual(DEFAULT_ROOM_SETTINGS);
		expect(normalizeRoomSettings(null)).toEqual(DEFAULT_ROOM_SETTINGS);
		expect(normalizeRoomSettings({})).toEqual(DEFAULT_ROOM_SETTINGS);
	});

	it('falls back per-field when the default pairing is not live-selectable', () => {
		// ensemble is upgrade-only, so it may not be the LIVE default — that field falls back.
		const out = normalizeRoomSettings({ defaultEngine: 'ensemble', defaultModel: 'instrumental_clean' });
		expect(out.defaultEngine).toBe(DEFAULT_ENGINE);
		expect(out.defaultModel).toBe(DEFAULT_MODEL);
	});

	it('accepts a valid live default and a valid (even upgrade-only) upgrade target', () => {
		const out = normalizeRoomSettings({
			defaultEngine: 'demucs',
			defaultModel: 'htdemucs_ft',
			enqueueUpgrade: true,
			upgradeEngine: 'ensemble',
			upgradeModel: 'instrumental_clean'
		});
		expect(out.defaultModel).toBe('htdemucs_ft');
		expect(out.enqueueUpgrade).toBe(true);
		expect(out.upgradeEngine).toBe('ensemble'); // upgrade target MAY be upgrade-only
		expect(out.upgradeModel).toBe('instrumental_clean');
	});

	it('an invalid upgrade pairing falls back but keeps a valid live default', () => {
		const out = normalizeRoomSettings({
			defaultEngine: 'demucs',
			defaultModel: 'htdemucs',
			upgradeEngine: 'roformer',
			upgradeModel: 'garbage'
		});
		expect(out.defaultModel).toBe('htdemucs');
		expect(out.upgradeEngine).toBe(DEFAULT_ROOM_SETTINGS.upgradeEngine);
		expect(out.upgradeModel).toBe(DEFAULT_ROOM_SETTINGS.upgradeModel);
	});

	it('coerces a non-boolean enqueueUpgrade to the default', () => {
		const out = normalizeRoomSettings({ enqueueUpgrade: 'yes' as unknown as boolean });
		expect(out.enqueueUpgrade).toBe(DEFAULT_ROOM_SETTINGS.enqueueUpgrade);
	});
});
