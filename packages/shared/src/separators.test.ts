import { describe, it, expect } from 'bun:test';
import {
	SEPARATOR_ENGINES,
	getEngine,
	isValidSeparator,
	isLiveSelectable,
	normalizeGlobalSettings,
	DEFAULT_GLOBAL_SETTINGS,
	DEFAULT_ENGINE,
	DEFAULT_MODEL,
	normalizeRoomSettings,
	TV_PROGRESS_STYLES,
	DEFAULT_ROOM_SETTINGS,
	resolveCookSeparator,
	separatorCost,
	estimateCookSeconds,
	qualityRank
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
		const model = ensemble!.models[0]!.id;
		expect(isValidSeparator('ensemble', model)).toBe(true); // valid as an upgrade target
		expect(isLiveSelectable('ensemble', model)).toBe(false); // but never as the live default
	});

	it('demucs whitelist carries the three htdemucs variants', () => {
		const ids = getEngine('demucs')!.models.map((m) => m.id);
		expect(ids).toContain('htdemucs');
		expect(ids).toContain('htdemucs_ft');
		expect(ids).toContain('htdemucs_6s');
	});

	it('does NOT offer a mel-band roformer model', () => {
		// The engine backing `roformer` implements only the BS-RoFormer architecture, and the former
		// mel-roformer-inst-v2 token mapped to a slug absent from its registry — a phone option no
		// worker could satisfy. Guards against it being re-added without the engine to run it.
		const ids = getEngine('roformer')!.models.map((m) => m.id);
		expect(ids.filter((id) => id.includes('mel'))).toEqual([]);
		expect(isValidSeparator('roformer', 'mel-roformer-inst-v2')).toBe(false);
		expect(qualityRank('roformer', 'mel-roformer-inst-v2')).toBe(0); // unranked ⇒ never an upgrade
	});
});

describe('measured cost', () => {
	it('every whitelisted model carries a cost record', () => {
		for (const engine of SEPARATOR_ENGINES) {
			for (const model of engine.models) {
				const cost = separatorCost(engine.id, model.id);
				expect(cost).toBeTruthy();
				expect(cost!.rtFactor).toBeGreaterThan(0);
				expect(['fp32', 'bf16']).toContain(cost!.cpuPrecision);
				expect(['measured', 'estimated']).toContain(cost!.provenance);
			}
		}
	});

	it('overlap is an integer window count where present, and absent on demucs', () => {
		// demucs's overlap is a 0–1 FRACTION with different semantics, so the field is deliberately
		// omitted there rather than carrying a value that means something else.
		for (const model of getEngine('demucs')!.models) {
			expect(model.cost.overlap).toBeUndefined();
		}
		for (const model of getEngine('roformer')!.models) {
			expect(Number.isInteger(model.cost.overlap)).toBe(true);
			expect(model.cost.overlap!).toBeGreaterThanOrEqual(1);
		}
	});

	it('the engine speed label agrees with its models measured cost', () => {
		// `speed` is a coarse UI hint and `rtFactor` is the measurement; this keeps them from drifting
		// apart as checkpoints are tuned. Bands: fast < 1× realtime, medium < 4×, slow beyond.
		for (const engine of SEPARATOR_ENGINES) {
			const worst = Math.max(...engine.models.map((m) => m.cost.rtFactor));
			const band = worst < 1 ? 'fast' : worst < 4 ? 'medium' : 'slow';
			expect(engine.speed).toBe(band);
		}
	});

	it('the live default is genuinely faster than realtime', () => {
		// A live cook has to finish while the singer waits, so the default must be sub-realtime.
		expect(separatorCost(DEFAULT_ENGINE, DEFAULT_MODEL)!.rtFactor).toBeLessThan(1);
	});

	it('estimateCookSeconds scales with song length and hardware', () => {
		// htdemucs is 0.29: a 200s song is ~58s on the reference box.
		expect(estimateCookSeconds('demucs', 'htdemucs', 200)).toBe(58);
		// a box twice as fast halves it
		expect(estimateCookSeconds('demucs', 'htdemucs', 200, 0.5)).toBe(29);
		// roformer is the upgrade tier: minutes, not seconds
		expect(estimateCookSeconds('roformer', 'bs-roformer-1297', 200)!).toBeGreaterThan(1000);
	});

	it('estimateCookSeconds returns null rather than guessing', () => {
		expect(estimateCookSeconds('demucs', 'no-such-model', 200)).toBeNull();
		expect(estimateCookSeconds('nope', 'htdemucs', 200)).toBeNull();
		expect(estimateCookSeconds('demucs', 'htdemucs', 0)).toBeNull();
		expect(estimateCookSeconds('demucs', 'htdemucs', Number.NaN)).toBeNull();
	});
});

describe('normalizeGlobalSettings', () => {
	it('returns defaults for empty/nullish input', () => {
		expect(normalizeGlobalSettings(undefined)).toEqual(DEFAULT_GLOBAL_SETTINGS);
		expect(normalizeGlobalSettings(null)).toEqual(DEFAULT_GLOBAL_SETTINGS);
		expect(normalizeGlobalSettings({})).toEqual(DEFAULT_GLOBAL_SETTINGS);
	});

	it('falls back per-field when the default pairing is not live-selectable', () => {
		// ensemble is upgrade-only, so it may not be the LIVE default — that field falls back.
		const out = normalizeGlobalSettings({ defaultEngine: 'ensemble', defaultModel: 'instrumental_clean' });
		expect(out.defaultEngine).toBe(DEFAULT_ENGINE);
		expect(out.defaultModel).toBe(DEFAULT_MODEL);
	});

	it('accepts a valid live default and a valid (even upgrade-only) upgrade target', () => {
		const out = normalizeGlobalSettings({
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
		const out = normalizeGlobalSettings({
			defaultEngine: 'demucs',
			defaultModel: 'htdemucs',
			upgradeEngine: 'roformer',
			upgradeModel: 'garbage'
		});
		expect(out.defaultModel).toBe('htdemucs');
		expect(out.upgradeEngine).toBe(DEFAULT_GLOBAL_SETTINGS.upgradeEngine);
		expect(out.upgradeModel).toBe(DEFAULT_GLOBAL_SETTINGS.upgradeModel);
	});

	it('coerces a non-boolean enqueueUpgrade to the default', () => {
		const out = normalizeGlobalSettings({ enqueueUpgrade: 'yes' as unknown as boolean });
		expect(out.enqueueUpgrade).toBe(DEFAULT_GLOBAL_SETTINGS.enqueueUpgrade);
	});
});

describe('room scope', () => {
	it('defaults to a usable interstitial and no quality ceiling', () => {
		expect(normalizeRoomSettings(undefined)).toEqual(DEFAULT_ROOM_SETTINGS);
		expect(DEFAULT_ROOM_SETTINGS.maxQualityRank).toBeNull();
	});

	it('clamps a nonsensical interstitial rather than rejecting the whole room', () => {
		// an unbounded interstitial would strand the TV between songs
		expect(normalizeRoomSettings({ interstitialMs: -500 }).interstitialMs).toBe(0);
		expect(normalizeRoomSettings({ interstitialMs: 999_999 }).interstitialMs).toBe(15_000);
		expect(normalizeRoomSettings({ interstitialMs: 1200 }).interstitialMs).toBe(1200);
		expect(normalizeRoomSettings({ interstitialMs: NaN }).interstitialMs).toBe(DEFAULT_ROOM_SETTINGS.interstitialMs);
	});

	it('treats a non-positive or non-numeric ceiling as no ceiling', () => {
		expect(normalizeRoomSettings({ maxQualityRank: 0 }).maxQualityRank).toBeNull();
		expect(normalizeRoomSettings({ maxQualityRank: -3 }).maxQualityRank).toBeNull();
		expect(normalizeRoomSettings({ maxQualityRank: 20 }).maxQualityRank).toBe(20);
	});
});

describe('resolveCookSeparator', () => {
	const withCap = (cap: number | null, global = DEFAULT_GLOBAL_SETTINGS) => ({
		global,
		room: { tvProgressStyle: 'card' as const, interstitialMs: 2500, maxQualityRank: cap }
	});

	it('uses the global default when the room sets no ceiling', () => {
		expect(resolveCookSeparator(withCap(null))).toEqual({
			engine: DEFAULT_GLOBAL_SETTINGS.defaultEngine,
			model: DEFAULT_GLOBAL_SETTINGS.defaultModel
		});
	});

	it('uses the global default when it already sits under the ceiling', () => {
		// htdemucs ranks 10; a ceiling of 35 does not constrain it
		expect(resolveCookSeparator(withCap(35))).toEqual({ engine: 'demucs', model: 'htdemucs' });
	});

	it('caps DOWNWARD to the best pairing under the ceiling', () => {
		const global = { ...DEFAULT_GLOBAL_SETTINGS, defaultEngine: 'roformer' as const, defaultModel: 'bs-roformer-1297' };
		// roformer ranks 35; a ceiling of 20 forces the best pairing at or under 20 → htdemucs_ft
		expect(resolveCookSeparator(withCap(20, global))).toEqual({ engine: 'demucs', model: 'htdemucs_ft' });
	});

	it('a room ceiling can never RAISE quality above the global choice', () => {
		// global is the floor-setting authority because it is bounded by what the fleet can run
		const global = { ...DEFAULT_GLOBAL_SETTINGS, defaultEngine: 'demucs' as const, defaultModel: 'htdemucs' };
		const picked = resolveCookSeparator(withCap(999, global));
		expect(picked).toEqual({ engine: 'demucs', model: 'htdemucs' }); // not upgraded to roformer
	});

	it('never resolves to an upgrade-only engine for a live cook', () => {
		const global = { ...DEFAULT_GLOBAL_SETTINGS, defaultEngine: 'roformer' as const, defaultModel: 'bs-roformer-1297' };
		const picked = resolveCookSeparator(withCap(44, global)); // 44 sits just under ensemble's 45
		expect(picked.engine).not.toBe('ensemble');
	});
});

describe('tv progress styles', () => {
	it('offers Off as the last choice, so the opt-out is not mistaken for a treatment', () => {
		expect(TV_PROGRESS_STYLES.map((s) => s.id)).toEqual(['card', 'corner', 'edge', 'off']);
		expect(TV_PROGRESS_STYLES.every((s) => s.label && s.note)).toBe(true);
	});

	it('normalizes a known style and keeps the current one when a write is junk', () => {
		expect(normalizeRoomSettings({ tvProgressStyle: 'off' }).tvProgressStyle).toBe('off');
		const room = { ...DEFAULT_ROOM_SETTINGS, tvProgressStyle: 'edge' as const };
		expect(normalizeRoomSettings({ tvProgressStyle: 'nope' as never }, room).tvProgressStyle).toBe('edge');
	});
});
