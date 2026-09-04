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
	resolveLyricsPresentation,
	separatorCost,
	estimateCookSeconds,
	qualityRank,
	normalizeJoinOrigin,
	type RoomSettings
} from './separators';
import {
	LYRICS_BALL_STYLES,
	LYRICS_HIGHLIGHTS,
	DEFAULT_LYRICS_BALL,
	DEFAULT_LYRICS_HIGHLIGHT,
	DEFAULT_LYRICS_LEAD_MS,
	MAX_LYRICS_LEAD_MS,
	LYRICS_FONTS,
	LYRICS_CASES,
	DEFAULT_LYRICS_FONT,
	DEFAULT_LYRICS_CASE,
	DEFAULT_LYRICS_SCALE_PCT,
	MIN_LYRICS_SCALE_PCT,
	MAX_LYRICS_SCALE_PCT,
	DEFAULT_LYRICS_LINES_BEFORE,
	DEFAULT_LYRICS_LINES_AFTER,
	MAX_LYRICS_LINES_BEFORE,
	MAX_LYRICS_LINES_AFTER
} from './lyrics-engines';

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
		// Spread the defaults rather than listing fields: this helper cares about maxQualityRank only,
		// and an inline literal made every future RoomSettings field a compile error here.
		room: { ...DEFAULT_ROOM_SETTINGS, maxQualityRank: cap }
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

describe('join origin', () => {
	// The address the TV advertises. Global rather than room-scoped (it names the deployment) and
	// settable rather than env-only, because the TV's own URL is often unreachable from a phone — a
	// WSL2 host can open /tv only as `localhost`, which points every phone at itself.
	it('defaults to empty, meaning "not declared — fall back to the env var, then the request"', () => {
		expect(DEFAULT_GLOBAL_SETTINGS.joinOrigin).toBe('');
	});

	it('strips path, query and trailing slash so a pasted address-bar value works', () => {
		expect(normalizeJoinOrigin('http://10.0.0.5:3000/tv?x=1')).toBe('http://10.0.0.5:3000');
		expect(normalizeJoinOrigin('http://10.0.0.5:3000/')).toBe('http://10.0.0.5:3000');
		expect(normalizeJoinOrigin('  https://party.example  ')).toBe('https://party.example');
	});

	it('distinguishes CLEARED from REJECTED, so emptying the field falls back rather than failing', () => {
		// '' is a legitimate value; null is "not a usable origin". Collapsing the two would either make
		// the field impossible to clear or make a typo silently re-enable auto-detection.
		expect(normalizeJoinOrigin('')).toBe('');
		expect(normalizeJoinOrigin('   ')).toBe('');
		expect(normalizeJoinOrigin('192.168.1.20:3000')).toBeNull(); // no scheme — not openable
		expect(normalizeJoinOrigin('not a url')).toBeNull();
		expect(normalizeJoinOrigin(undefined)).toBeNull();
	});

	it('refuses a scheme a phone browser cannot open', () => {
		for (const bad of ['ftp://10.0.0.5', 'javascript:alert(1)', 'file:///etc/passwd', 'ws://10.0.0.5']) {
			expect(normalizeJoinOrigin(bad)).toBeNull();
		}
	});

	it('a junk write keeps the declared address instead of reverting to auto-detection', () => {
		// Reverting would put `localhost` back in the QR — the exact failure the setting exists to fix.
		const declared = { ...DEFAULT_GLOBAL_SETTINGS, joinOrigin: 'http://10.69.1.169:3000' };
		expect(normalizeGlobalSettings({ joinOrigin: 'nonsense' }, declared).joinOrigin).toBe('http://10.69.1.169:3000');
		// An omitted field is a patch, not a clear.
		expect(normalizeGlobalSettings({ asrModel: 'base' }, declared).joinOrigin).toBe('http://10.69.1.169:3000');
		// An explicit empty string IS a clear.
		expect(normalizeGlobalSettings({ joinOrigin: '' }, declared).joinOrigin).toBe('');
	});
});

describe('lyrics presentation registries', () => {
	it('every default is a real registry entry', () => {
		expect(LYRICS_BALL_STYLES.some((s) => s.id === DEFAULT_LYRICS_BALL)).toBe(true);
		expect(LYRICS_HIGHLIGHTS.some((h) => h.id === DEFAULT_LYRICS_HIGHLIGHT)).toBe(true);
	});

	it('every entry carries a label and a stated tradeoff', () => {
		// The house rule for a registry: a style cannot be added without saying what it costs.
		for (const s of [...LYRICS_BALL_STYLES, ...LYRICS_HIGHLIGHTS]) {
			expect(s.label.length).toBeGreaterThan(0);
			expect(s.note.length).toBeGreaterThan(0);
		}
	});

	it('exactly one marker survives line-only timing, and it is the no-marker one', () => {
		// If this ever grows past one, resolveLyricsPresentation's degrade target needs revisiting.
		const anchorless = LYRICS_BALL_STYLES.filter((s) => !s.needsWords);
		expect(anchorless.map((s) => s.id)).toEqual(['off']);
	});

	it('the defaults reproduce the TV that shipped before this setting existed', () => {
		// A bouncing ball + word-by-word pink + 0.3s lead was hardcoded. Regressing these silently
		// changes every existing room on upgrade.
		expect(DEFAULT_LYRICS_BALL).toBe('bounce');
		expect(DEFAULT_LYRICS_HIGHLIGHT).toBe('word');
		expect(DEFAULT_LYRICS_LEAD_MS).toBe(300);
	});
});

describe('normalizeRoomSettings — lyrics presentation', () => {
	it('keeps valid styles and falls back per-field to CURRENT values', () => {
		const room = { ...DEFAULT_ROOM_SETTINGS, lyricsBall: 'underline' as const, lyricsHighlight: 'line' as const };
		expect(normalizeRoomSettings({ lyricsBall: 'steady' }, room).lyricsBall).toBe('steady');
		// A rejected field must not drag an unrelated choice back to the hardcoded default.
		expect(normalizeRoomSettings({ lyricsBall: 'disco' as never }, room).lyricsBall).toBe('underline');
		expect(normalizeRoomSettings({ lyricsBall: 'disco' as never }, room).lyricsHighlight).toBe('line');
	});

	it('clamps the lead rather than rejecting it, and refuses a negative lead', () => {
		expect(normalizeRoomSettings({ lyricsLeadMs: -200 }).lyricsLeadMs).toBe(0);
		expect(normalizeRoomSettings({ lyricsLeadMs: 99_999 }).lyricsLeadMs).toBe(MAX_LYRICS_LEAD_MS);
		expect(normalizeRoomSettings({ lyricsLeadMs: 450 }).lyricsLeadMs).toBe(450);
		expect(normalizeRoomSettings({ lyricsLeadMs: 450.6 }).lyricsLeadMs).toBe(451);
		expect(normalizeRoomSettings({ lyricsLeadMs: NaN }).lyricsLeadMs).toBe(DEFAULT_LYRICS_LEAD_MS);
	});
});

describe('resolveLyricsPresentation', () => {
	const settings = (syncMode: 'forced' | 'lines', room: Partial<RoomSettings> = {}) => ({
		global: { ...DEFAULT_GLOBAL_SETTINGS, syncMode },
		room: { ...DEFAULT_ROOM_SETTINGS, ...room }
	});

	it('honours the room exactly when word timings exist', () => {
		const r = resolveLyricsPresentation(settings('forced', { lyricsBall: 'steady', lyricsHighlight: 'word' }));
		expect(r).toEqual({ ball: 'steady', highlight: 'word', leadSec: 0.3, clamped: false });
	});

	it('a room may render BELOW the granularity produced — that is a real choice, not a clamp', () => {
		// The whole point of the room layer: the aligner ran, the word data is on disk, and this screen
		// still elects line-level because its songs have patchy timing.
		const r = resolveLyricsPresentation(settings('forced', { lyricsHighlight: 'line', lyricsBall: 'off' }));
		expect(r.highlight).toBe('line');
		expect(r.clamped).toBe(false);
	});

	it('drops a word-anchored marker under line-only sync, because it has no word to sit on', () => {
		for (const ball of ['bounce', 'steady', 'underline'] as const) {
			const r = resolveLyricsPresentation(settings('lines', { lyricsBall: ball }));
			expect(r.ball).toBe('off');
			expect(r.clamped).toBe(true);
		}
	});

	it('degrades a word highlight to line, NOT to off', () => {
		// The room asked to be shown where it is. Line timing can honour that; turning the highlight off
		// would discard a choice made for reasons unrelated to granularity.
		const r = resolveLyricsPresentation(settings('lines', { lyricsHighlight: 'word' }));
		expect(r.highlight).toBe('line');
	});

	it('reports clamped=false when line-only sync can satisfy the room as asked', () => {
		const r = resolveLyricsPresentation(settings('lines', { lyricsBall: 'off', lyricsHighlight: 'line' }));
		expect(r).toEqual({ ball: 'off', highlight: 'line', leadSec: 0.3, clamped: false });
	});

	it('passes the lead through as seconds regardless of clamping', () => {
		expect(resolveLyricsPresentation(settings('forced', { lyricsLeadMs: 0 })).leadSec).toBe(0);
		expect(resolveLyricsPresentation(settings('lines', { lyricsLeadMs: 1200 })).leadSec).toBe(1.2);
	});
});

describe('lyrics text registries', () => {
	it('every default is a real registry entry', () => {
		expect(LYRICS_FONTS.some((f) => f.id === DEFAULT_LYRICS_FONT)).toBe(true);
		expect(LYRICS_CASES.some((c) => c.id === DEFAULT_LYRICS_CASE)).toBe(true);
	});

	it('every entry carries a label and a stated tradeoff', () => {
		for (const e of [...LYRICS_FONTS, ...LYRICS_CASES]) {
			expect(e.label.length).toBeGreaterThan(0);
			expect(e.note.length).toBeGreaterThan(0);
		}
	});

	it('no font stack fetches anything — the box may have no route out', () => {
		// The hard constraint: a webfont or a CDN url here would render as nothing on a LAN deployment.
		// Same reason the icon system vendors path geometry instead of taking a font dependency.
		for (const f of LYRICS_FONTS) {
			expect(f.stack).not.toMatch(/https?:|url\(|@import/i);
		}
	});

	it('every font stack ends in a generic family, so a missing face degrades instead of tofu', () => {
		const generics = ['sans-serif', 'serif', 'monospace', 'system-ui', 'ui-monospace', 'cursive'];
		for (const f of LYRICS_FONTS) {
			if (f.stack === 'inherit') continue; // inherits the app's own stack, which has its own fallback
			const last = f.stack.split(',').pop()!.trim().replace(/['"]/g, '');
			expect(generics).toContain(last);
		}
	});

	it('the default case leaves the source text alone', () => {
		// `natural` must be a true no-op: the lyrics are the words the source gave us.
		expect(LYRICS_CASES.find((c) => c.id === DEFAULT_LYRICS_CASE)?.transform).toBe('none');
	});

	it('the defaults reproduce the reel that shipped before these settings existed', () => {
		// 100% of the PR #8 scale, the app's own font, unmodified case, and the 2 + current + 2 rows the
		// viewport's 9.5em was built for. Regressing any of these silently changes every existing room.
		expect(DEFAULT_LYRICS_SCALE_PCT).toBe(100);
		expect(DEFAULT_LYRICS_FONT).toBe('system');
		expect(DEFAULT_LYRICS_CASE).toBe('natural');
		expect(DEFAULT_LYRICS_LINES_BEFORE).toBe(2);
		expect(DEFAULT_LYRICS_LINES_AFTER).toBe(2);
	});

	it('the scale floor is a legibility guard, not a formality', () => {
		// If this ever drops toward 0 the distance-based scale stops guaranteeing anything.
		expect(MIN_LYRICS_SCALE_PCT).toBeGreaterThanOrEqual(80);
		expect(MAX_LYRICS_SCALE_PCT).toBeGreaterThan(MIN_LYRICS_SCALE_PCT);
	});
});

describe('normalizeRoomSettings — lyrics text', () => {
	it('clamps the scale to the legibility band rather than rejecting it', () => {
		expect(normalizeRoomSettings({ lyricsScalePct: 10 }).lyricsScalePct).toBe(MIN_LYRICS_SCALE_PCT);
		expect(normalizeRoomSettings({ lyricsScalePct: 9999 }).lyricsScalePct).toBe(MAX_LYRICS_SCALE_PCT);
		expect(normalizeRoomSettings({ lyricsScalePct: 125 }).lyricsScalePct).toBe(125);
		expect(normalizeRoomSettings({ lyricsScalePct: 124.6 }).lyricsScalePct).toBe(125);
		expect(normalizeRoomSettings({ lyricsScalePct: NaN }).lyricsScalePct).toBe(DEFAULT_LYRICS_SCALE_PCT);
	});

	it('accepts ZERO lines before or after — no history and no preview are both real choices', () => {
		expect(normalizeRoomSettings({ lyricsLinesBefore: 0 }).lyricsLinesBefore).toBe(0);
		expect(normalizeRoomSettings({ lyricsLinesAfter: 0 }).lyricsLinesAfter).toBe(0);
		// A negative count is not a choice, it is a bad write.
		expect(normalizeRoomSettings({ lyricsLinesBefore: -4 }).lyricsLinesBefore).toBe(0);
	});

	it('caps row counts so the reel cannot outgrow its share of the screen', () => {
		expect(normalizeRoomSettings({ lyricsLinesBefore: 99 }).lyricsLinesBefore).toBe(MAX_LYRICS_LINES_BEFORE);
		expect(normalizeRoomSettings({ lyricsLinesAfter: 99 }).lyricsLinesAfter).toBe(MAX_LYRICS_LINES_AFTER);
	});

	it('keeps before and after independent, so an asymmetric reel is expressible', () => {
		const r = normalizeRoomSettings({ lyricsLinesBefore: 0, lyricsLinesAfter: 3 });
		expect(r.lyricsLinesBefore).toBe(0);
		expect(r.lyricsLinesAfter).toBe(3);
	});

	it('falls back per-field to CURRENT values, not to the defaults', () => {
		const room = {
			...DEFAULT_ROOM_SETTINGS,
			lyricsFont: 'serif' as const,
			lyricsCase: 'upper' as const,
			lyricsScalePct: 140
		};
		// One junk field must not discard three unrelated choices the room already made.
		const r = normalizeRoomSettings({ lyricsFont: 'comic-sans' as never }, room);
		expect(r.lyricsFont).toBe('serif');
		expect(r.lyricsCase).toBe('upper');
		expect(r.lyricsScalePct).toBe(140);
	});

	it('normalizes a valid font and case', () => {
		expect(normalizeRoomSettings({ lyricsFont: 'mono' }).lyricsFont).toBe('mono');
		expect(normalizeRoomSettings({ lyricsCase: 'lower' }).lyricsCase).toBe('lower');
	});
});
