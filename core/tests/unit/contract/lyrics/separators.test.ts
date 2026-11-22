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
} from '$lib/contract/lyrics/separators';
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
	resolveProcessSeparator,
	resolveLyricsPresentation,
	normalizeJoinOrigin,
	type RoomSettings
} from '$lib/contract/core/settings';
import { DEFAULT_STAGE_COLOR, stageHueToHex } from '$lib/contract/presentation/colors';
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
} from '$lib/contract/lyrics/lyrics-engines';
import type { LyricsCandidate } from '$lib/contract/lyrics/lyrics';

describe('separator registry', () => {
	it('the live default is a real, live-selectable pairing', () => {
		expect(isValidSeparator(DEFAULT_ENGINE, DEFAULT_MODEL)).toBe(true);
		expect(isLiveSelectable(DEFAULT_ENGINE, DEFAULT_MODEL)).toBe(true);
	});

	it('every engine has a distinct capability, and only the zoo may list no models', () => {
		// The "at least one model" half USED TO APPLY TO EVERY ENGINE, and the `audiosep` engine now
		// legitimately breaks it: its models are reported by the workers in `worker:catalogue`, because only a
		// worker knows which checkpoints its installed library can run. A name listed here would be an
		// unverifiable claim about a remote box — which is exactly how this file came to advertise three
		// models no worker could run.
		const caps = new Set<string>();
		for (const e of SEPARATOR_ENGINES) {
			if (e.id !== 'audiosep') expect(e.models.length).toBeGreaterThan(0);
			expect(caps.has(e.capability)).toBe(false); // capabilities route jobs, so must be unique
			caps.add(e.capability);
		}
	});

	it('the zoo engine lists no models, so nothing here can claim a remote box can run something', () => {
		const zoo = SEPARATOR_ENGINES.find((e) => e.id === 'audiosep');
		expect(zoo).toBeDefined();
		expect(zoo!.models).toEqual([]);
	});

	it('no engine advertises a capability no worker implements', () => {
		// `stems:ensemble` was advertised for as long as this registry existed and NEVER implemented, behind
		// two upgrade-only models. The failure was silent by construction: upgrades simply never ran, and
		// `hasCapableWorker` was false forever with nothing on screen to say so.
		const advertised = SEPARATOR_ENGINES.map((e) => e.capability);
		expect(advertised).not.toContain('stems:ensemble');
		expect(SEPARATOR_ENGINES.some((e) => e.id === 'ensemble')).toBe(false);
	});

	it('rejects unknown engine or unknown model', () => {
		expect(isValidSeparator('nope', 'htdemucs')).toBe(false);
		expect(isValidSeparator('demucs', 'no-such-model')).toBe(false);
	});

	it('the ensemble engine is gone, and re-adding it as a constant would be the same bug', () => {
		// It was a real ENTRY but never a real ENGINE: `stems:ensemble` had no adapter on any worker, so the
		// two upgrade-only models it carried made every upgrade unservable, silently. An ensemble runtime, if
		// built, announces itself through `worker:catalogue` like every other model.
		expect(getEngine('ensemble')).toBeUndefined();
		expect(isValidSeparator('ensemble', 'instrumental_clean')).toBe(false);
		expect(isLiveSelectable('ensemble', 'instrumental_clean')).toBe(false);
	});

	it('demucs whitelist carries the three htdemucs variants', () => {
		const ids = getEngine('demucs')!.models.map((m) => m.id);
		expect(ids).toContain('htdemucs');
		expect(ids).toContain('htdemucs_ft');
		expect(ids).toContain('htdemucs_6s');
	});

	it('offers audiosep as a live-selectable engine whose models come from the workers', () => {
		const audiosep = getEngine('audiosep');
		expect(audiosep).toBeTruthy();
		expect(audiosep!.capability).toBe('stems:audiosep'); // distinct capability routes the process
		expect(audiosep!.liveSelectable).toBe(true);
		// `instrumental_becruily` was the one hardcoded entry here and NO WORKER COULD RUN IT — there was no
		// audiosep adapter at all. Picking it queued a job that no capability matched. It is not replaced by a
		// different hardcoded name; the worker reports what it has.
		expect(isValidSeparator('audiosep', 'instrumental_becruily')).toBe(false);
	});

	it('does NOT offer a mel-band roformer model', () => {
		// The `roformer` engine implements only BS-RoFormer, so a mel-roformer token maps to a slug absent from its
		// registry: a phone option no worker can satisfy.
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
		// demucs's overlap is a 0–1 FRACTION, so the field is omitted there rather than carrying a different meaning.
		for (const model of getEngine('demucs')!.models) {
			expect(model.cost.overlap).toBeUndefined();
		}
		for (const model of getEngine('roformer')!.models) {
			expect(Number.isInteger(model.cost.overlap)).toBe(true);
			expect(model.cost.overlap!).toBeGreaterThanOrEqual(1);
		}
	});

	it('the engine speed label agrees with its models measured cost', () => {
		// `speed` is a coarse UI hint, `rtFactor` the measurement. Bands: fast < 1× realtime, medium < 4×.
		for (const engine of SEPARATOR_ENGINES) {
			// The zoo engine lists no models, so there is no cost here to agree with — its per-model figures
			// arrive from the workers and are UPSTREAM numbers, which deliberately never become an `rtFactor`
			// in this registry. `Math.max()` of nothing is -Infinity, which would silently read as "fast".
			if (engine.models.length === 0) continue;
			const worst = Math.max(...engine.models.map((m) => m.cost.rtFactor));
			const band = worst < 1 ? 'fast' : worst < 4 ? 'medium' : 'slow';
			expect(engine.speed).toBe(band);
		}
	});

	it('the live default is genuinely faster than realtime', () => {
		// A live process finishes while the singer waits, so the default must be sub-realtime.
		expect(separatorCost(DEFAULT_ENGINE, DEFAULT_MODEL)!.rtFactor).toBeLessThan(1);
	});
});

describe('quality rank', () => {
	// No whitelisted pairing may resolve to the sentinel 0: a rank-0 pairing is invisible to
	// `resolveProcessSeparator`'s ladder (settings.ts skips `rank === 0`) and can publish over nothing (isQualityUpgrade
	// refuses a rank-0 candidate) — silent in both directions.
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
		const out = normalizeGlobalSettings({ defaultEngine: 'ensemble', defaultModel: 'instrumental_clean' });
		expect(out.defaultEngine).toBe(DEFAULT_ENGINE);
		expect(out.defaultModel).toBe(DEFAULT_MODEL);
	});

	it('accepts a valid live default and a WORKER-REPORTED upgrade target', () => {
		// The pairing that matters now, and the one that used to be silently discarded: `isValidSeparator`
		// consulted only the static list, so a token the fleet reported was replaced by the default here —
		// the picker would offer 135 models and the setting would snap back on save.
		const out = normalizeGlobalSettings({
			defaultEngine: 'demucs',
			defaultModel: 'htdemucs_ft',
			enqueueUpgrade: true,
			upgradeEngine: 'audiosep',
			upgradeModel: 'roformer-model-bs-roformer-viperx-1297'
		});
		expect(out.defaultModel).toBe('htdemucs_ft');
		expect(out.enqueueUpgrade).toBe(true);
		expect(out.upgradeEngine).toBe('audiosep');
		expect(out.upgradeModel).toBe('roformer-model-bs-roformer-viperx-1297');
	});

	it('a malformed zoo token still falls back, so the shape check is a gate and not a bypass', () => {
		const out = normalizeGlobalSettings({
			defaultEngine: 'demucs',
			defaultModel: 'htdemucs',
			upgradeEngine: 'audiosep',
			upgradeModel: 'Not A Token!'
		});
		expect(out.upgradeModel).toBe(DEFAULT_GLOBAL_SETTINGS.upgradeModel);
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
		expect(normalizeRoomSettings({ songIntroMs: -500 }).songIntroMs).toBe(MIN_SONG_INTRO_MS);
		expect(normalizeRoomSettings({ songIntroMs: 999_999 }).songIntroMs).toBe(MAX_SONG_INTRO_MS);
		expect(normalizeRoomSettings({ songIntroMs: 1200 }).songIntroMs).toBe(1200);
		expect(normalizeRoomSettings({ songIntroMs: NaN }).songIntroMs).toBe(DEFAULT_ROOM_SETTINGS.songIntroMs);
	});

	it('0 is NOT a valid duration — the toggle owns off, so there is one way to say it', () => {
		expect(normalizeRoomSettings({ songIntroMs: 0 }).songIntroMs).toBe(MIN_SONG_INTRO_MS);
	});

	it('the toggle survives a duration change, which is why it is not a sentinel', () => {
		// A 0-means-off encoding destroys the duration on the way off, so off and duration are separate.
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

	it('loudnessNormalization ships OFF and is a plain boolean toggle', () => {
		expect(DEFAULT_ROOM_SETTINGS.loudnessNormalization).toBe(false);
		expect(normalizeRoomSettings({ loudnessNormalization: true }).loudnessNormalization).toBe(true);
		expect(normalizeRoomSettings({ loudnessNormalization: false }).loudnessNormalization).toBe(false);
		const on = normalizeRoomSettings({ loudnessNormalization: true });
		expect(normalizeRoomSettings({ loudnessNormalization: 'on' as never }, on).loudnessNormalization).toBe(true);
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
		// The settings page sends null for "No limit", so this IS the production clear payload. maxQualityRank is the one
		// field that deliberately ignores `base`: making it fall back like its 17 siblings leaves the cap permanently
		// unremovable and passes the whole suite.
		const capped = { ...DEFAULT_ROOM_SETTINGS, maxQualityRank: 20 };
		expect(normalizeRoomSettings({ maxQualityRank: null as never }, capped).maxQualityRank).toBeNull();
		expect(normalizeRoomSettings({ maxQualityRank: 35 }, capped).maxQualityRank).toBe(35);
		// An invalid write does NOT keep the old cap: it drops to no ceiling.
		expect(normalizeRoomSettings({ maxQualityRank: 0 }, capped).maxQualityRank).toBeNull();
	});
});

describe('resolveProcessSeparator', () => {
	const withCap = (cap: number | null, global = DEFAULT_GLOBAL_SETTINGS) => ({
		global,
		// Spread the defaults rather than listing fields, or every future RoomSettings field is a compile error here.
		room: { ...DEFAULT_ROOM_SETTINGS, maxQualityRank: cap }
	});

	it('uses the global default when the room sets no ceiling', () => {
		expect(resolveProcessSeparator(withCap(null))).toEqual({
			engine: DEFAULT_GLOBAL_SETTINGS.defaultEngine,
			model: DEFAULT_GLOBAL_SETTINGS.defaultModel
		});
	});

	it('uses the global default when it already sits under the ceiling', () => {
		expect(resolveProcessSeparator(withCap(35))).toEqual({ engine: 'demucs', model: 'htdemucs' });
	});

	it('caps DOWNWARD to the best pairing under the ceiling', () => {
		const global = { ...DEFAULT_GLOBAL_SETTINGS, defaultEngine: 'roformer' as const, defaultModel: 'bs-roformer-1297' };
		// roformer ranks 35, so a ceiling of 20 forces the best pairing at or under 20 (htdemucs_ft).
		expect(resolveProcessSeparator(withCap(20, global))).toEqual({ engine: 'demucs', model: 'htdemucs_ft' });
	});

	it('a room ceiling can never RAISE quality above the global choice', () => {
		// Global is the floor-setting authority, because it is bounded by what the fleet can run.
		const global = { ...DEFAULT_GLOBAL_SETTINGS, defaultEngine: 'demucs' as const, defaultModel: 'htdemucs' };
		const picked = resolveProcessSeparator(withCap(999, global));
		expect(picked).toEqual({ engine: 'demucs', model: 'htdemucs' }); // not upgraded to roformer
	});

	it('the search always lands on a live-selectable pairing', () => {
		// Entering the SEARCH loop needs a default ranking ABOVE the cap. `ensemble:instrumental_clean` (45)
		// used to provide that and has been removed from the registry, so the highest remaining rung does:
		// roformer:bs-roformer-1297 at 35, against a cap of 30.
		const global = {
			...DEFAULT_GLOBAL_SETTINGS,
			defaultEngine: 'roformer' as const,
			defaultModel: 'bs-roformer-1297'
		};
		const picked = resolveProcessSeparator(withCap(30, global));
		expect(qualityRank(picked.engine, picked.model)).toBeLessThanOrEqual(30);
		expect(isLiveSelectable(picked.engine, picked.model)).toBe(true);
	});

	it('the upgrade-only filter in the search is currently UNREACHABLE, and that is worth knowing', () => {
		// `resolveProcessSeparator` skips engines with `liveSelectable: false`. With `ensemble` removed there
		// is no such engine left, so that branch cannot fire. Asserted rather than deleted: the guard is
		// correct and should stay, but anyone adding an upgrade-only engine needs to know they are the first
		// to exercise it since the registry changed.
		expect(SEPARATOR_ENGINES.filter((e) => !e.liveSelectable)).toEqual([]);
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
	// The address the TV advertises: global because it names the deployment, and settable rather than env-only because
	// the TV's own URL is often unreachable from a phone (a WSL2 host can open /tv only as `localhost`, which points
	// every phone at itself).
	it('defaults to empty, meaning "not declared — fall back to the env var, then the request"', () => {
		expect(DEFAULT_GLOBAL_SETTINGS.joinOrigin).toBe('');
	});

	it('strips path, query and trailing slash so a pasted address-bar value works', () => {
		expect(normalizeJoinOrigin('http://10.0.0.5:3000/tv?x=1')).toBe('http://10.0.0.5:3000');
		expect(normalizeJoinOrigin('http://10.0.0.5:3000/')).toBe('http://10.0.0.5:3000');
		expect(normalizeJoinOrigin('  https://party.example  ')).toBe('https://party.example');
	});

	it('distinguishes CLEARED from REJECTED, so emptying the field falls back rather than failing', () => {
		// '' is a legitimate value and null is "not a usable origin": collapsing them makes the field either impossible to
		// clear or a typo that silently re-enables auto-detection.
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
		// Reverting puts `localhost` back in the QR, which is what this setting exists to fix.
		const declared = { ...DEFAULT_GLOBAL_SETTINGS, joinOrigin: 'http://192.168.1.20:3000' };
		expect(normalizeGlobalSettings({ joinOrigin: 'nonsense' }, declared).joinOrigin).toBe('http://192.168.1.20:3000');
		expect(normalizeGlobalSettings({ asrModel: 'base' }, declared).joinOrigin).toBe('http://192.168.1.20:3000');
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
		const anchorless = LYRICS_BALL_STYLES.filter((s) => !s.needsWords);
		expect(anchorless.map((s) => s.id)).toEqual(['off']);
	});

	it('the defaults reproduce the TV that shipped before this setting existed', () => {
		// Regressing any of these silently changes every existing room on upgrade.
		expect(DEFAULT_LYRICS_BALL).toBe('off');
		expect(DEFAULT_LYRICS_HIGHLIGHT).toBe('word');
		// NOT 0 ANY MORE, and it is the one default here that was deliberately moved: ITU-R BT.1359's
		// tolerance is ASYMMETRIC (a late highlight is noticed at ~45 ms, an early one at ~125 ms) and +40 ms
		// of DISPLAY lead moves the 'undetectable' share 73.2% -> 78.6% over the 5693 hand-timed word onsets
		// of the bench corpus — where 40 ms is the swept ARGMAX, in all three claim populations (the review's
		// own 66.0 -> 75.0 was the same measurement on the pre-W4 clock and the base bundle, and it still
		// reproduces there). A hard literal, not `.toBe(SOME_CONST)`, so this pins the measured value.
		// `DEFAULT_LYRICS_LEAD_MS`' own docstring carries the measurement and the TV-latency caveat; the
		// worker's acoustic `ONSET_LEAD_SEC` did NOT move.
		expect(DEFAULT_LYRICS_LEAD_MS).toBe(40);
	});
});

describe('normalizeRoomSettings — lyrics presentation', () => {
	it('keeps valid styles and falls back per-field to CURRENT values', () => {
		const room = { ...DEFAULT_ROOM_SETTINGS, lyricsBall: 'underline' as const, lyricsHighlight: 'line' as const };
		expect(normalizeRoomSettings({ lyricsBall: 'steady' }, room).lyricsBall).toBe('steady');
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

/** The room default's DISPLAY lead, in seconds. Read from the constant on purpose in the cases below: they
 *  are about the MARKS and the clamp, and the lead rides along in the same object. The case that pins the
 *  lead's measured VALUE (40 ms, BT.1359) is a literal, above, and so is the pass-through case. */
const DEFAULT_LEAD_SEC = DEFAULT_LYRICS_LEAD_MS / 1000;

describe('resolveLyricsPresentation', () => {
	const settings = (syncMode: 'forced' | 'lines', room: Partial<RoomSettings> = {}) => ({
		global: { ...DEFAULT_GLOBAL_SETTINGS, syncMode },
		room: { ...DEFAULT_ROOM_SETTINGS, ...room }
	});

	it('honours the room exactly when word timings exist', () => {
		const r = resolveLyricsPresentation(settings('forced', { lyricsBall: 'steady', lyricsHighlight: 'word' }));
		expect(r).toEqual({ ball: 'steady', highlight: 'word', leadSec: DEFAULT_LEAD_SEC, clamped: false });
	});

	it('a room may render BELOW the granularity produced — that is a real choice, not a clamp', () => {
		// The room layer's whole point: word data is on disk and this screen still elects line-level.
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
		// `clamped` is an OR over the two marks, never an AND: a room that turned the marker off but kept a word highlight
		// has still had a choice overridden, and the Settings notice is the only place it is told. Every other
		// clamped=true case degrades BOTH marks, so an AND-mutant passes them unchanged — each fixture here needs word
		// timings for exactly ONE mark. Expected values are literals.
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
		// Line timing can honour "show me where I am"; turning the highlight off discards a choice made for reasons
		// unrelated to granularity.
		const r = resolveLyricsPresentation(settings('lines', { lyricsHighlight: 'word' }));
		expect(r.highlight).toBe('line');
	});

	it('reports clamped=false when line-only sync can satisfy the room as asked', () => {
		const r = resolveLyricsPresentation(settings('lines', { lyricsBall: 'off', lyricsHighlight: 'line' }));
		expect(r).toEqual({ ball: 'off', highlight: 'line', leadSec: DEFAULT_LEAD_SEC, clamped: false });
	});

	it('passes the lead through as seconds regardless of clamping', () => {
		expect(resolveLyricsPresentation(settings('forced', { lyricsLeadMs: 0 })).leadSec).toBe(0);
		expect(resolveLyricsPresentation(settings('lines', { lyricsLeadMs: 1200 })).leadSec).toBe(1.2);
	});
});

// THE INNER BOUND — the per-song half of the clamp. The tests above all vary `syncMode`, a FLEET-WIDE setting, so the
// only line-only case they can state is "the whole deployment produces line timings". What breaks is a word-level fleet
// playing ONE line-only song, which needs a per-song parameter. A matrix, because the failure mode is fixing one branch
// of a resolution chain and leaving its siblings wrong.
describe('resolveLyricsPresentation — the per-song inner bound', () => {
	const wordRoom = { lyricsBall: 'bounce', lyricsHighlight: 'word' } as const;
	const settings = (syncMode: 'forced' | 'lines', room: Partial<RoomSettings> = {}) => ({
		global: { ...DEFAULT_GLOBAL_SETTINGS, syncMode },
		room: { ...DEFAULT_ROOM_SETTINGS, ...room }
	});

	/**
	 * A LINE-ONLY SONG in the shape the real worker publishes: a refused or skipped alignment records `"timing": "line"`
	 * with empty `words`. That candidate `timing` is the ONLY per-song granularity signal a pure resolver can read — no
	 * doc, no filesystem — so it is what the inner bound keys on.
	 *
	 * A real `LyricsCandidate` rather than a bare string, so the field name and its value are both pinned to the
	 * producer: a fixture inventing plausible field names manufactured a false CRITICAL against a working overlay here.
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
		// `syncMode: 'forced'` is the default, so this is a stock deployment's first LRC without an alignment.
		const r = resolveLyricsPresentation(settings('forced', wordRoom), lineOnlySong.timing);
		expect(r.highlight).toBe('line'); // was 'word' — the reel painted plain white
		expect(r.ball).toBe('off'); // was 'bounce' — a marker with no word to sit on
		expect(r.clamped).toBe(true);
	});

	it('a word-level fleet playing a word-timed song is untouched', () => {
		// Pinned so the inner bound cannot over-clamp into the case that already worked.
		const r = resolveLyricsPresentation(settings('forced', wordRoom), wordSong.timing);
		expect(r).toEqual({ ball: 'bounce', highlight: 'word', leadSec: DEFAULT_LEAD_SEC, clamped: false });
	});

	it("a song with NO usable timing clamps too — 'none' is not 'word'", () => {
		// Unreachable through `pickBestLyrics` today, which is why it is asserted: the bound must fail CLOSED on any
		// known non-word value, not enumerate the one reachable this month.
		const r = resolveLyricsPresentation(settings('forced', wordRoom), 'none');
		expect(r.highlight).toBe('line');
		expect(r.clamped).toBe(true);
	});

	it('UNKNOWN granularity does NOT clamp — absent and null both mean "we cannot say"', () => {
		// An artifact with no recorded timing most likely DOES carry word timings (the aligner wrote them), so clamping
		// here strips working word highlighting off every legacy song. Both spellings of unknown must behave
		// identically: a null candidate, and no argument at all.
		const absent = resolveLyricsPresentation(settings('forced', wordRoom));
		const explicitNull = resolveLyricsPresentation(settings('forced', wordRoom), null);
		expect(absent).toEqual({ ball: 'bounce', highlight: 'word', leadSec: DEFAULT_LEAD_SEC, clamped: false });
		expect(explicitNull).toEqual(absent);
	});

	it('the OUTER bound still dominates: a line-only fleet clamps whatever the song claims', () => {
		// A song row can claim word timings no process in a `lines` deployment could have produced (a stale candidate from
		// before the mode changed), so the fleet bound wins: the two are an AND.
		for (const timing of ['word', 'line', 'none', null] as const) {
			const r = resolveLyricsPresentation(settings('lines', wordRoom), timing);
			expect(r.highlight).toBe('line');
			expect(r.ball).toBe('off');
			expect(r.clamped).toBe(true);
		}
	});

	it('a room asking for line-level is never reported as clamped, by either bound', () => {
		// `clamped` drives an "overridden" notice, so a room that asked for what it got must not raise it.
		const asked = { lyricsBall: 'off', lyricsHighlight: 'line' } as const;
		expect(resolveLyricsPresentation(settings('forced', asked), 'line').clamped).toBe(false);
		expect(resolveLyricsPresentation(settings('forced', asked), 'none').clamped).toBe(false);
		expect(resolveLyricsPresentation(settings('lines', asked), 'word').clamped).toBe(false);
	});

	it('the inner bound reads the candidate FIELD, not a hand-copied granularity', () => {
		// Driving the resolver straight off `LyricsCandidate.timing` keeps ONE vocabulary: a second, hand-maintained
		// notion of granularity drifts from what the worker writes.
		const fromCandidate = resolveLyricsPresentation(settings('forced', wordRoom), lineOnlySong.timing);
		const fromLiteral = resolveLyricsPresentation(settings('forced', wordRoom), 'line');
		expect(fromCandidate).toEqual(fromLiteral);
		// Every value the worker can write must resolve to a decision, with no silent default.
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
		// A webfont or a CDN url here renders as nothing on a LAN deployment.
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
		// `natural` must be a true no-op.
		expect(LYRICS_CASES.find((c) => c.id === DEFAULT_LYRICS_CASE)?.transform).toBe('none');
	});

	it('the defaults reproduce the reel that shipped before these settings existed', () => {
		// The app's own font, unmodified case, and the 2 + current + 2 rows the viewport's 9.5em was built for. Regressing
		// any of these silently changes every existing room.
		expect(DEFAULT_LYRICS_SCALE_PCT).toBe(100);
		expect(DEFAULT_LYRICS_FONT).toBe('system');
		expect(DEFAULT_LYRICS_CASE).toBe('natural');
		expect(DEFAULT_LYRICS_LINES_BEFORE).toBe(2);
		expect(DEFAULT_LYRICS_LINES_AFTER).toBe(2);
	});

	it('the scale floor is a legibility guard, not a formality', () => {
		expect(MIN_LYRICS_SCALE_PCT).toBeGreaterThanOrEqual(80);
		expect(MAX_LYRICS_SCALE_PCT).toBeGreaterThan(MIN_LYRICS_SCALE_PCT);
	});

	it('the scale is rebased so the neutral 100 renders what 80 rendered before', () => {
		// The neutral fold is a HARD FACT, never re-derived with the render op: LYRICS_SCALE_BASE is exactly 0.8, so
		// neutral 100 renders 0.8x, 125 renders 1.0x and the ceiling 300 renders 2.4x. Literals here; the render
		// EXPRESSION is pinned against production source elsewhere.
		expect(LYRICS_SCALE_BASE).toBe(0.8);
		// old-80 render, expressed as a literal the fold must reproduce at the neutral point:
		expect(DEFAULT_LYRICS_SCALE_PCT * LYRICS_SCALE_BASE).toBe(80); // 100 * 0.8 (percent points)
		// 125 is the value that renders the OLD 1.0x neutral; 300 the new ceiling at 2.4x:
		expect(125 * LYRICS_SCALE_BASE).toBe(100); // 125 -> 1.0x
		expect(MAX_LYRICS_SCALE_PCT * LYRICS_SCALE_BASE).toBe(240); // 300 -> 2.4x
	});

	it('the neutral point and the widened band', () => {
		// Neutral stays 100, so the DB default and every stored value keep their integer meaning with no migration; the
		// floor IS the neutral point, because nothing honest renders below 0.8x.
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
		// One junk field must not discard unrelated choices the room already made.
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
		// Only the opt-out-comes-first invariant, so adding a style does not touch two tests.
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

	// A stored colour is either parseable or not, so the rule is normalise-or-keep: no wrapping or snapping, which is
	// what a stored hue ANGLE needed.
	it('normalises the stage colour to canonical hex rather than storing what was sent', () => {
		expect(normalizeRoomSettings({ tvBackgroundColor: '#ABC' }).tvBackgroundColor).toBe('#aabbcc');
		expect(normalizeRoomSettings({ tvBackgroundColor: '#AABBCC' }).tvBackgroundColor).toBe('#aabbcc');
		expect(normalizeRoomSettings({ tvBackgroundColor: '#001d31' }).tvBackgroundColor).toBe('#001d31');
	});

	it('accepts a colour the retired hue pin could never have produced', () => {
		// Brightness is deliberately unbounded here: the lyric reel carries its own stroke.
		expect(normalizeRoomSettings({ tvBackgroundColor: '#ffffff' }).tvBackgroundColor).toBe('#ffffff');
		expect(normalizeRoomSettings({ tvBackgroundColor: '#ff0000' }).tvBackgroundColor).toBe('#ff0000');
	});

	it('falls back on a stage colour that is not a parseable hex', () => {
		const room = { ...DEFAULT_ROOM_SETTINGS, tvBackgroundColor: '#002215' };
		for (const junk of ['rebeccapurple', 'rgb(1,2,3)', '#7c5cff30', '#12345', '', 240, NaN, null, undefined, {}]) {
			expect(normalizeRoomSettings({ tvBackgroundColor: junk as never }, room).tvBackgroundColor).toBe('#002215');
		}
	});

	it('the default stage colour is what the old hue-240 default rendered as', () => {
		// An existing box that never opened Settings must look byte-identical.
		expect(DEFAULT_ROOM_SETTINGS.tvBackgroundColor).toBe(DEFAULT_STAGE_COLOR);
		expect(DEFAULT_STAGE_COLOR).toBe(stageHueToHex(240));
	});

	it('every normalized stage colour is one shape the CSS layer can assume', () => {
		for (const raw of ['#abc', '#AABBCC', '#12345', '#ffffff', 'junk', '']) {
			const c = normalizeRoomSettings({ tvBackgroundColor: raw as never }).tvBackgroundColor;
			expect(c).toMatch(/^#[0-9a-f]{6}$/);
		}
	});

	// The stage dimmer: a 0..1 fraction, normalised beside the colour it dims.
	it('the default stage dim is 0 — no dim, today TV exactly', () => {
		expect(DEFAULT_ROOM_SETTINGS.tvBackgroundDim).toBe(0);
	});

	it('normalises the stage dim: clamps to 0..1, rounds to a hundredth', () => {
		expect(normalizeRoomSettings({ tvBackgroundDim: 0 }).tvBackgroundDim).toBe(0);
		expect(normalizeRoomSettings({ tvBackgroundDim: 1 }).tvBackgroundDim).toBe(1);
		expect(normalizeRoomSettings({ tvBackgroundDim: 0.5 }).tvBackgroundDim).toBe(0.5);
		expect(normalizeRoomSettings({ tvBackgroundDim: 0.126 }).tvBackgroundDim).toBe(0.13);
		expect(normalizeRoomSettings({ tvBackgroundDim: -1 }).tvBackgroundDim).toBe(0);
		expect(normalizeRoomSettings({ tvBackgroundDim: 5 }).tvBackgroundDim).toBe(1);
	});

	it('keeps the room current dim on a junk write, like every other field', () => {
		const room = { ...DEFAULT_ROOM_SETTINGS, tvBackgroundDim: 0.35 };
		for (const junk of ['0.5', NaN, Infinity, null, undefined, {}]) {
			expect(normalizeRoomSettings({ tvBackgroundDim: junk as never }, room).tvBackgroundDim).toBe(0.35);
		}
	});
});

describe('tv visualizers', () => {
	it('the visualizer style is offered last, after the plain colour choices', () => {
		expect(TV_BACKGROUND_STYLES.map((s) => s.id)).toEqual(['off', 'gradient', 'singer', 'solid', 'visualizer']);
	});

	it('defaults to plasma — the one every old media player had', () => {
		expect(DEFAULT_ROOM_SETTINGS.tvVisualizer).toBe('plasma');
		// The default background stays off, so adding this changes nothing on an existing box.
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
		// Switching away and back must not forget the choice, like tvBackgroundColor off `solid`.
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
