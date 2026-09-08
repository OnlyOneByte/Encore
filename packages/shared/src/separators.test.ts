import { describe, it, expect } from 'bun:test';
import {
	SEPARATOR_ENGINES,
	getEngine,
	isValidSeparator,
	isLiveSelectable,
	DEFAULT_ENGINE,
	DEFAULT_MODEL,
	separatorCost,
	qualityRank
} from './separators';
import {
	normalizeGlobalSettings,
	DEFAULT_GLOBAL_SETTINGS,
	normalizeRoomSettings,
	TV_PROGRESS_STYLES,
	TV_BACKGROUND_STYLES,
	TV_VISUALIZERS,
	isTvVisualizer,
	isTvBackgroundStyle,
	DEFAULT_ROOM_SETTINGS,
	MIN_SONG_INTRO_MS,
	MAX_SONG_INTRO_MS,
	effectiveSongIntroMs,
	resolveCookSeparator,
	resolveLyricsPresentation,
	normalizeJoinOrigin,
	type RoomSettings
} from './settings';
import { DEFAULT_STAGE_COLOR, stageHueToHex } from './colors';
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
	LYRICS_SCALE_BASE,
	MIN_LYRICS_SCALE_PCT,
	MAX_LYRICS_SCALE_PCT,
	DEFAULT_LYRICS_LINES_BEFORE,
	DEFAULT_LYRICS_LINES_AFTER,
	MAX_LYRICS_LINES_BEFORE,
	MAX_LYRICS_LINES_AFTER
} from './lyrics-engines';
import type { LyricsCandidate } from './lyrics';

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
});

describe('quality rank', () => {
	// The sibling of 'every whitelisted model carries a cost record' for the OTHER per-model field.
	// `rank` is a required field on `SeparatorModel`, so a whitelisted model missing a rank cannot even
	// compile — but this pins the runtime invariant the type protects: no whitelisted pairing may
	// resolve to the sentinel 0. Before rank moved onto the registry, `qualityRank` looked a pairing up
	// in a hand-maintained parallel `QUALITY_RANK` table, so a whitelisted model absent from that table
	// silently ranked 0 — invisible to `resolveCookSeparator`'s ladder (settings.ts skips `rank === 0`)
	// and unable to publish over any instrumental (isQualityUpgrade returns false for a rank-0 candidate).
	// This reds on the base where the table was hand-maintained and could not guarantee registry coverage.
	it('every whitelisted model has a positive quality rank (never the silent-0 sentinel)', () => {
		for (const engine of SEPARATOR_ENGINES) {
			for (const model of engine.models) {
				expect(qualityRank(engine.id, model.id)).toBeGreaterThan(0);
			}
		}
	});

	// The 0 sentinel is still reachable — but ONLY for a pairing that is not in the registry at all.
	it('a pairing not in the registry ranks 0', () => {
		expect(qualityRank('demucs', 'bogus')).toBe(0);
		expect(qualityRank('nope', 'htdemucs')).toBe(0);
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
	it('defaults to a usable song intro and no quality ceiling', () => {
		expect(normalizeRoomSettings(undefined)).toEqual(DEFAULT_ROOM_SETTINGS);
		expect(DEFAULT_ROOM_SETTINGS.maxQualityRank).toBeNull();
		expect(DEFAULT_ROOM_SETTINGS.songIntroEnabled).toBe(true);
	});

	it('clamps a nonsensical song intro rather than rejecting the whole room', () => {
		// an unbounded intro would strand the TV between songs
		expect(normalizeRoomSettings({ songIntroMs: -500 }).songIntroMs).toBe(MIN_SONG_INTRO_MS);
		expect(normalizeRoomSettings({ songIntroMs: 999_999 }).songIntroMs).toBe(MAX_SONG_INTRO_MS);
		expect(normalizeRoomSettings({ songIntroMs: 1200 }).songIntroMs).toBe(1200);
		expect(normalizeRoomSettings({ songIntroMs: NaN }).songIntroMs).toBe(DEFAULT_ROOM_SETTINGS.songIntroMs);
	});

	it('0 is NOT a valid duration — the toggle owns off, so there is one way to say it', () => {
		expect(normalizeRoomSettings({ songIntroMs: 0 }).songIntroMs).toBe(MIN_SONG_INTRO_MS);
	});

	it('the toggle survives a duration change, which is why it is not a sentinel', () => {
		// The old 0-means-off encoding destroyed the duration on the way off; this is the regression.
		const off = normalizeRoomSettings({ songIntroEnabled: false, songIntroMs: 1500 });
		expect(off.songIntroMs).toBe(1500);
		expect(effectiveSongIntroMs(off)).toBe(0); // the TV hard-cuts
		const backOn = normalizeRoomSettings({ songIntroEnabled: true }, off);
		expect(backOn.songIntroMs).toBe(1500); // the dialled-in timing came back
		expect(effectiveSongIntroMs(backOn)).toBe(1500);
	});

	it('a non-boolean toggle keeps the room current choice', () => {
		const off = normalizeRoomSettings({ songIntroEnabled: false });
		expect(normalizeRoomSettings({ songIntroEnabled: 'yes' as never }, off).songIntroEnabled).toBe(false);
	});

	it('clamps the presence grace window, where 0 IS meaningful', () => {
		expect(normalizeRoomSettings({ presenceGraceMinutes: 0 }).presenceGraceMinutes).toBe(0);
		expect(normalizeRoomSettings({ presenceGraceMinutes: -10 }).presenceGraceMinutes).toBe(0);
		expect(normalizeRoomSettings({ presenceGraceMinutes: 99_999 }).presenceGraceMinutes).toBe(1440);
		expect(normalizeRoomSettings({ presenceGraceMinutes: 45 }).presenceGraceMinutes).toBe(45);
		expect(DEFAULT_ROOM_SETTINGS.presenceGraceMinutes).toBe(90);
	});

	it('treats a non-positive or non-numeric ceiling as no ceiling', () => {
		expect(normalizeRoomSettings({ maxQualityRank: 0 }).maxQualityRank).toBeNull();
		expect(normalizeRoomSettings({ maxQualityRank: -3 }).maxQualityRank).toBeNull();
		expect(normalizeRoomSettings({ maxQualityRank: 20 }).maxQualityRank).toBe(20);
	});

	it('an explicit null CLEARS a ceiling the room already set', () => {
		// settings/+page.svelte:594 sends null for the "No limit" option, so this IS the production
		// clear payload. maxQualityRank is the one field that deliberately ignores `base` (returns null,
		// not d.maxQualityRank) — without this test, making it fall back like its 17 siblings would leave
		// the cap permanently unremovable and pass the whole suite.
		const capped = { ...DEFAULT_ROOM_SETTINGS, maxQualityRank: 20 };
		expect(normalizeRoomSettings({ maxQualityRank: null as never }, capped).maxQualityRank).toBeNull();
		// a genuinely new ceiling still replaces the old one
		expect(normalizeRoomSettings({ maxQualityRank: 35 }, capped).maxQualityRank).toBe(35);
		// and an invalid write does NOT keep the old cap — it drops to no ceiling
		expect(normalizeRoomSettings({ maxQualityRank: 0 }, capped).maxQualityRank).toBeNull();
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
		// Drives the SEARCH loop, which only runs when the global default ranks ABOVE the cap. A
		// live-selectable default can never reach it: the highest is roformer at 35 and every ensemble
		// rung is 40+, so any cap that admits an ensemble pairing also admits the default and returns
		// early (the vacuous case this replaces). Only an out-of-contract global — one
		// `normalizeGlobalSettings` would refuse — reaches the `liveSelectable` filter, so that is what
		// is exercised here, asserting the invariant fails CLOSED. Same stance as the `:477` sibling.
		const global = {
			...DEFAULT_GLOBAL_SETTINGS,
			defaultEngine: 'ensemble' as const,
			defaultModel: 'instrumental_clean'
		};
		// cap 44 skips the early return (ensemble:instrumental_clean ranks 45 > 44) and admits
		// ensemble:instrumental_full (40); the filter must reject it, leaving roformer (35) as best.
		const picked = resolveCookSeparator(withCap(44, global));
		expect(picked.engine).not.toBe('ensemble');
		expect(isLiveSelectable(picked.engine, picked.model)).toBe(true);
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
		// A bouncing ball + word-by-word pink was hardcoded; the lead now ships at 0 (#629). Regressing these silently
		// changes every existing room on upgrade.
		expect(DEFAULT_LYRICS_BALL).toBe('off');
		expect(DEFAULT_LYRICS_HIGHLIGHT).toBe('word');
		expect(DEFAULT_LYRICS_LEAD_MS).toBe(0); // #629: global lead ships OFF by default
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
		expect(r).toEqual({ ball: 'steady', highlight: 'word', leadSec: 0, clamped: false });
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

	it('a room where only ONE mark needs words is still reported as clamped', () => {
		// `clamped` is an OR over the two marks, not an AND: a room that turned the marker off but kept
		// a word highlight (or the reverse) has still had a choice overridden, and the Settings notice
		// at routes/settings/+page.svelte:755 is the only place it is told so. Every OTHER clamped=true
		// case here degrades BOTH marks, so an AND-mutant of settings.ts passes them unchanged. Each
		// fixture below is a room where exactly one mark needs word timings, so OR-clamped !== AND-clamped
		// and flipping the operator reddens it. Expected values are hard-coded, not derived by re-running
		// the operator under test.
		const highlightOnly = resolveLyricsPresentation(settings('lines', { lyricsBall: 'off', lyricsHighlight: 'word' }));
		expect(highlightOnly.ball).toBe('off'); // ball 'off' needs no words — unchanged
		expect(highlightOnly.highlight).toBe('line'); // word highlight degraded to line
		expect(highlightOnly.clamped).toBe(true); // AND-mutant would report false and hide the notice

		const ballOnly = resolveLyricsPresentation(settings('lines', { lyricsBall: 'bounce', lyricsHighlight: 'line' }));
		expect(ballOnly.ball).toBe('off'); // bounce needs words — dropped
		expect(ballOnly.highlight).toBe('line'); // line highlight needs no words — unchanged
		expect(ballOnly.clamped).toBe(true); // AND-mutant would report false and hide the notice
	});

	it('degrades a word highlight to line, NOT to off', () => {
		// The room asked to be shown where it is. Line timing can honour that; turning the highlight off
		// would discard a choice made for reasons unrelated to granularity.
		const r = resolveLyricsPresentation(settings('lines', { lyricsHighlight: 'word' }));
		expect(r.highlight).toBe('line');
	});

	it('reports clamped=false when line-only sync can satisfy the room as asked', () => {
		const r = resolveLyricsPresentation(settings('lines', { lyricsBall: 'off', lyricsHighlight: 'line' }));
		expect(r).toEqual({ ball: 'off', highlight: 'line', leadSec: 0, clamped: false });
	});

	it('passes the lead through as seconds regardless of clamping', () => {
		expect(resolveLyricsPresentation(settings('forced', { lyricsLeadMs: 0 })).leadSec).toBe(0);
		expect(resolveLyricsPresentation(settings('lines', { lyricsLeadMs: 1200 })).leadSec).toBe(1.2);
	});
});

/*
 * THE INNER BOUND — the per-song half of the clamp.
 *
 * The tests above could not express this issue's failing case. Every one of them varies `syncMode`,
 * a FLEET-WIDE setting, so the only line-only case they can state is "the whole deployment produces
 * line timings" — which always clamped correctly. The case that shipped broken is a word-level fleet
 * playing ONE line-only song, and the resolver had no parameter that could say so. A gap in what a
 * signature can express is not covered by adding more cases at that signature.
 *
 * The two bounds are enumerated as a matrix rather than as prose, because the documented failure mode
 * here is fixing one branch of a resolution chain and leaving its siblings wrong.
 */
describe('resolveLyricsPresentation — the per-song inner bound', () => {
	const wordRoom = { lyricsBall: 'bounce', lyricsHighlight: 'word' } as const;
	const settings = (syncMode: 'forced' | 'lines', room: Partial<RoomSettings> = {}) => ({
		global: { ...DEFAULT_GLOBAL_SETTINGS, syncMode },
		room: { ...DEFAULT_ROOM_SETTINGS, ...room }
	});

	/**
	 * A LINE-ONLY SONG, in the shape the real worker publishes.
	 *
	 * Verified against `apps/worker/src/lyrics/source.py:line_synced_lyrics` (the doc) and
	 * `apps/worker/src/steps/lyrics.py:333` (the candidate): a refused or skipped alignment publishes
	 * `{"lines":[{start,end,text,"words":[]}],"words":[]}` and records `"timing": "line"`. The
	 * candidate's `timing` is the ONLY per-song granularity signal a pure resolver can read — it has
	 * no doc and no filesystem — so it is the field the inner bound must key on.
	 *
	 * Stated as a real candidate rather than a bare string so the field name and its value are both
	 * pinned to `LyricsCandidate`. A fixture that invents field names manufactured a false CRITICAL
	 * against a working overlay once already in this repo (`c544f46`), and the way it did it was by
	 * being a plausible shape nobody had checked against the producer.
	 */
	const lineOnlySong: LyricsCandidate = {
		ref: 'derived/lyrics/song.lrclib.line.json',
		textSource: 'lrclib',
		timing: 'line',
		textConfidence: 'high',
		createdAt: 1
	};
	const wordSong: LyricsCandidate = { ...lineOnlySong, timing: 'word' };

	it('THE BUG: a word-level fleet playing a LINE-ONLY song still clamps the room down', () => {
		// The reported symptom. `syncMode: 'forced'` is the default, so this is what a stock
		// deployment does the first time an LRC lands without a usable alignment.
		const r = resolveLyricsPresentation(settings('forced', wordRoom), lineOnlySong.timing);
		expect(r.highlight).toBe('line'); // was 'word' — the reel painted plain white
		expect(r.ball).toBe('off'); // was 'bounce' — a marker with no word to sit on
		expect(r.clamped).toBe(true);
	});

	it('a word-level fleet playing a word-timed song is untouched', () => {
		// The case that always worked, pinned so the inner bound cannot over-clamp into it. This is
		// the branch the pre-existing e2e coverage exercised — and the only one.
		const r = resolveLyricsPresentation(settings('forced', wordRoom), wordSong.timing);
		expect(r).toEqual({ ball: 'bounce', highlight: 'word', leadSec: 0, clamped: false });
	});

	it("a song with NO usable timing clamps too — 'none' is not 'word'", () => {
		// Unreachable through `pickBestLyrics` today (lyricsRank returns 0, so it is never chosen),
		// which is exactly why it is asserted: the bound must fail CLOSED on any known non-word
		// value, not enumerate the one value that happens to be reachable this month.
		const r = resolveLyricsPresentation(settings('forced', wordRoom), 'none');
		expect(r.highlight).toBe('line');
		expect(r.clamped).toBe(true);
	});

	it('UNKNOWN granularity does NOT clamp — absent and null both mean "we cannot say"', () => {
		// A pre-candidate-tracking artifact has no recorded timing, and most such artifacts DO carry
		// word timings (the aligner is what wrote them). Clamping here would silently strip working
		// word highlighting off every legacy song. Both spellings of unknown must behave identically:
		// `chosenCandidate()` returns null, and the Settings page passes no argument at all.
		const absent = resolveLyricsPresentation(settings('forced', wordRoom));
		const explicitNull = resolveLyricsPresentation(settings('forced', wordRoom), null);
		expect(absent).toEqual({ ball: 'bounce', highlight: 'word', leadSec: 0, clamped: false });
		expect(explicitNull).toEqual(absent);
	});

	it('the OUTER bound still dominates: a line-only fleet clamps whatever the song claims', () => {
		// The sibling that must not regress. A song row can claim word timings that no cook in a
		// `lines` deployment could have produced (a stale candidate from before the mode changed),
		// and the fleet bound has to win — the two bounds are an AND, not a replacement.
		for (const timing of ['word', 'line', 'none', null] as const) {
			const r = resolveLyricsPresentation(settings('lines', wordRoom), timing);
			expect(r.highlight).toBe('line');
			expect(r.ball).toBe('off');
			expect(r.clamped).toBe(true);
		}
	});

	it('a room asking for line-level is never reported as clamped, by either bound', () => {
		// `clamped` drives a "your choice is being overridden" notice. A room that asked for the thing
		// it is getting has not been overridden, and saying so would train the operator to ignore it.
		const asked = { lyricsBall: 'off', lyricsHighlight: 'line' } as const;
		expect(resolveLyricsPresentation(settings('forced', asked), 'line').clamped).toBe(false);
		expect(resolveLyricsPresentation(settings('forced', asked), 'none').clamped).toBe(false);
		expect(resolveLyricsPresentation(settings('lines', asked), 'word').clamped).toBe(false);
	});

	it('the inner bound reads the candidate FIELD, not a hand-copied granularity', () => {
		// Guards the wire-shape hole this repo has been bitten by: a resolver keyed on a second,
		// hand-maintained notion of granularity would drift from what the worker writes. Driving the
		// resolver straight off `LyricsCandidate.timing` is what keeps one vocabulary.
		const fromCandidate = resolveLyricsPresentation(settings('forced', wordRoom), lineOnlySong.timing);
		const fromLiteral = resolveLyricsPresentation(settings('forced', wordRoom), 'line');
		expect(fromCandidate).toEqual(fromLiteral);
		// And the producer's vocabulary is the one being read: every value the worker can write for
		// this field must resolve to a decision, with no silent default.
		for (const timing of ['word', 'line', 'none'] as const) {
			expect(resolveLyricsPresentation(settings('forced', wordRoom), timing).clamped).toBe(timing !== 'word');
		}
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

	it('the scale is rebased so the neutral 100 renders what 80 rendered before', () => {
		// The neutral fold is a HARD FACT, not re-derived with the render op: LYRICS_SCALE_BASE is
		// exactly 0.8, so the neutral 100 (100/100 * 0.8) renders 0.8x — precisely what the old 80
		// rendered. The value that now renders the OLD neutral 1.0x is 125, and the raised ceiling 300
		// renders 2.4x. These target multipliers are asserted as literals; the render EXPRESSION that
		// consumes the base is pinned separately against production source in lyrics-reel-cap.test.ts.
		expect(LYRICS_SCALE_BASE).toBe(0.8);
		// old-80 render, expressed as a literal the fold must reproduce at the neutral point:
		expect(DEFAULT_LYRICS_SCALE_PCT * LYRICS_SCALE_BASE).toBe(80); // 100 * 0.8 (percent points)
		// 125 is the value that renders the OLD 1.0x neutral; 300 the new ceiling at 2.4x:
		expect(125 * LYRICS_SCALE_BASE).toBe(100); // 125 -> 1.0x
		expect(MAX_LYRICS_SCALE_PCT * LYRICS_SCALE_BASE).toBe(240); // 300 -> 2.4x
	});

	it('the neutral point and the widened band', () => {
		// Neutral stays 100 (so the DB default and every stored value keep their integer meaning — no
		// migration), the floor IS the neutral point (nothing honest renders below the 0.8x floor), and
		// the ceiling is raised well past the old 160.
		expect(DEFAULT_LYRICS_SCALE_PCT).toBe(100);
		expect(MIN_LYRICS_SCALE_PCT).toBe(100);
		expect(MAX_LYRICS_SCALE_PCT).toBe(300);
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

describe('tv background styles', () => {
	it('leads with the opt-out so the default is not mistaken for a treatment', () => {
		// Ordering of the whole list is asserted by the `tv visualizers` block; this owns only the
		// invariant that the opt-out comes first, so adding a style does not touch two tests.
		expect(TV_BACKGROUND_STYLES[0]!.id).toBe('off');
		expect(TV_BACKGROUND_STYLES.every((s) => s.label && s.note)).toBe(true);
	});

	it('defaults to off, so an existing box looks identical after the migration', () => {
		expect(DEFAULT_ROOM_SETTINGS.tvBackgroundStyle).toBe('off');
	});

	it('guards the type at the boundary', () => {
		expect(isTvBackgroundStyle('singer')).toBe(true);
		expect(isTvBackgroundStyle('SINGER')).toBe(false);
		expect(isTvBackgroundStyle('rainbow')).toBe(false);
		expect(isTvBackgroundStyle(null)).toBe(false);
		expect(isTvBackgroundStyle(3)).toBe(false);
		expect(isTvBackgroundStyle(undefined)).toBe(false);
	});

	it('keeps the room current choice when a write is junk, rather than resetting to the default', () => {
		expect(normalizeRoomSettings({ tvBackgroundStyle: 'gradient' }).tvBackgroundStyle).toBe('gradient');
		const room = { ...DEFAULT_ROOM_SETTINGS, tvBackgroundStyle: 'singer' as const };
		expect(normalizeRoomSettings({ tvBackgroundStyle: 'nope' as never }, room).tvBackgroundStyle).toBe('singer');
	});

	it('rejecting one field never discards an unrelated choice the room already made', () => {
		const room = { ...DEFAULT_ROOM_SETTINGS, tvBackgroundStyle: 'solid' as const, tvBackgroundColor: '#123456' };
		const out = normalizeRoomSettings({ tvBackgroundStyle: 'garbage' as never }, room);
		expect(out.tvBackgroundStyle).toBe('solid');
		expect(out.tvBackgroundColor).toBe('#123456');
	});

	// #425 replaced the stored hue ANGLE with a real colour, so this block replaces the quantiser
	// assertions that used to live here. The angle needed wrapping and snapping because every number had
	// a meaning once wrapped; a colour is either parseable or it is not, so the rule is normalise-or-keep.
	it('normalises the stage colour to canonical hex rather than storing what was sent (#425)', () => {
		expect(normalizeRoomSettings({ tvBackgroundColor: '#ABC' }).tvBackgroundColor).toBe('#aabbcc');
		expect(normalizeRoomSettings({ tvBackgroundColor: '#AABBCC' }).tvBackgroundColor).toBe('#aabbcc');
		expect(normalizeRoomSettings({ tvBackgroundColor: '#001d31' }).tvBackgroundColor).toBe('#001d31');
	});

	it('accepts a colour the retired hue pin could never have produced (#425)', () => {
		// the ruling, as an assertion: brightness is no longer bounded here, because the lyric reel now
		// carries its own stroke (#750) instead of the field being restricted to spare it
		expect(normalizeRoomSettings({ tvBackgroundColor: '#ffffff' }).tvBackgroundColor).toBe('#ffffff');
		expect(normalizeRoomSettings({ tvBackgroundColor: '#ff0000' }).tvBackgroundColor).toBe('#ff0000');
	});

	it('falls back on a stage colour that is not a parseable hex (#425)', () => {
		const room = { ...DEFAULT_ROOM_SETTINGS, tvBackgroundColor: '#002215' };
		for (const junk of ['rebeccapurple', 'rgb(1,2,3)', '#7c5cff30', '#12', '', 240, NaN, null, undefined, {}]) {
			expect(normalizeRoomSettings({ tvBackgroundColor: junk as never }, room).tvBackgroundColor).toBe('#002215');
		}
	});

	it('the default stage colour is what the old hue-240 default rendered as (#425)', () => {
		// an existing box that never opened Settings must look byte-identical after the migration
		expect(DEFAULT_ROOM_SETTINGS.tvBackgroundColor).toBe(DEFAULT_STAGE_COLOR);
		expect(DEFAULT_STAGE_COLOR).toBe(stageHueToHex(240));
	});

	it('every normalized stage colour is one shape the CSS layer can assume (#425)', () => {
		for (const raw of ['#abc', '#AABBCC', '#000', '#ffffff', 'junk', '']) {
			const c = normalizeRoomSettings({ tvBackgroundColor: raw as never }).tvBackgroundColor;
			expect(c).toMatch(/^#[0-9a-f]{6}$/);
		}
	});
});

describe('tv visualizers', () => {
	it('the visualizer style is offered last, after the plain colour choices', () => {
		expect(TV_BACKGROUND_STYLES.map((s) => s.id)).toEqual(['off', 'gradient', 'singer', 'solid', 'visualizer']);
	});

	it('defaults to plasma — the one every old media player had', () => {
		expect(DEFAULT_ROOM_SETTINGS.tvVisualizer).toBe('plasma');
		// and the default background is still off, so adding this changes nothing on an existing box
		expect(DEFAULT_ROOM_SETTINGS.tvBackgroundStyle).toBe('off');
	});

	it('guards the type at the boundary', () => {
		expect(isTvVisualizer('plasma')).toBe(true);
		expect(isTvVisualizer('PLASMA')).toBe(false);
		expect(isTvVisualizer('bars')).toBe(false);
		expect(isTvVisualizer(null)).toBe(false);
		expect(isTvVisualizer(7)).toBe(false);
		expect(isTvVisualizer(undefined)).toBe(false);
	});

	it('keeps the room current visualizer when a write is junk', () => {
		expect(normalizeRoomSettings({ tvVisualizer: 'moire' }).tvVisualizer).toBe('moire');
		const room = { ...DEFAULT_ROOM_SETTINGS, tvVisualizer: 'starfield' as const };
		expect(normalizeRoomSettings({ tvVisualizer: 'nope' as never }, room).tvVisualizer).toBe('starfield');
	});

	it('the variant is remembered while another background is selected', () => {
		// Switching away from the visualizer and back must not forget the choice — the same property
		// tvBackgroundColor has when the style is not `solid`.
		const room = {
			...DEFAULT_ROOM_SETTINGS,
			tvBackgroundStyle: 'visualizer' as const,
			tvVisualizer: 'lissajous' as const
		};
		const away = normalizeRoomSettings({ tvBackgroundStyle: 'off' }, room);
		expect(away.tvVisualizer).toBe('lissajous');
		expect(normalizeRoomSettings({ tvBackgroundStyle: 'visualizer' }, away).tvVisualizer).toBe('lissajous');
	});

	it('a bad visualizer write never discards an unrelated choice', () => {
		const room = {
			...DEFAULT_ROOM_SETTINGS,
			tvVisualizer: 'moire' as const,
			tvBackgroundColor: '#281600',
			songIntroMs: 7000
		};
		const out = normalizeRoomSettings({ tvVisualizer: 'garbage' as never }, room);
		expect(out.tvVisualizer).toBe('moire');
		expect(out.tvBackgroundColor).toBe('#281600');
		expect(out.songIntroMs).toBe(7000);
	});

	it('every visualizer id is a plausible column value — no spaces or casing surprises', () => {
		for (const v of TV_VISUALIZERS) expect(v.id).toMatch(/^[a-z][a-z0-9]*$/);
	});
});
