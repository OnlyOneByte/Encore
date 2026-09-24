// The root config layer: `EffectiveSettings` (global + room) is what every client renders and what
// `queue:sync` carries. Scope rules and sentinels: see docs/SERVER.md#settings-scopes.

import {
	DEFAULT_ENGINE,
	DEFAULT_MODEL,
	SEPARATOR_ENGINES,
	isLiveSelectable,
	isValidSeparator,
	qualityRank,
	type SeparatorEngineId
} from '../lyrics/separators';
import { makeRegistry } from './registry';
import { DEFAULT_QUEUE_ORDER, isQueueOrder, type QueueOrderId } from '../queue/queue-order';
import { DEFAULT_FETCHER, isValidFetcher, type FetcherId } from '../process/fetchers';
import { DEFAULT_STAGE_COLOR, DEFAULT_STAGE_DIM, normalizeStageColor, normalizeStageDim } from '../presentation/colors';
import {
	DEFAULT_PRESENCE_GRACE_MINUTES,
	MAX_PRESENCE_GRACE_MINUTES,
	MIN_PRESENCE_GRACE_MINUTES
} from '../queue/membership';
import {
	DEFAULT_ASR_MODEL,
	DEFAULT_LYRICS_BALL,
	DEFAULT_LYRICS_CASE,
	DEFAULT_LYRICS_FONT,
	DEFAULT_LYRICS_HIGHLIGHT,
	DEFAULT_LYRICS_LEAD_MS,
	DEFAULT_LYRICS_LINES_AFTER,
	DEFAULT_LYRICS_LINES_BEFORE,
	DEFAULT_LYRICS_SCALE_PCT,
	DEFAULT_SYNC_MODE,
	MAX_LYRICS_LEAD_MS,
	MAX_LYRICS_LINES_AFTER,
	MAX_LYRICS_LINES_BEFORE,
	MAX_LYRICS_SCALE_PCT,
	MIN_LYRICS_SCALE_PCT,
	getLyricsBallStyle,
	getLyricsHighlight,
	getSyncMode,
	isValidAsrModel,
	isValidLyricsBall,
	isValidLyricsCase,
	isValidLyricsFont,
	isValidLyricsHighlight,
	isValidSyncMode,
	type AsrModelId,
	type LyricsBallStyleId,
	type LyricsCaseId,
	type LyricsFontId,
	type LyricsHighlightId,
	type SyncModeId
} from '../lyrics/lyrics-engines';
// TYPE-ONLY: lyrics.ts is dependency-free, and a value import is the first edge to compromise that.
import type { LyricsTiming } from '../lyrics/lyrics';

/** Writable by any joined singer. See docs/SERVER.md#settings-scopes. */
export interface GlobalSettings {
	/** Engine+model every new process uses. Must be a `liveSelectable` pairing. */
	defaultEngine: SeparatorEngineId;
	defaultModel: string;
	/** When true, a completed process chains a `stems-upgrade` from the RETAINED raw audio — no re-download. */
	enqueueUpgrade: boolean;
	/** Engine+model the upgrade targets. May be an upgrade-only engine (e.g. ensemble). */
	upgradeEngine: SeparatorEngineId;
	upgradeModel: string;
	/** Which downloader acquires source audio. `local` is never valid here. See docs/SERVER.md#settings-scopes. */
	defaultFetcher: FetcherId;
	/** Which Whisper checkpoint the ASR tier transcribes sung vocals with. */
	asrModel: AsrModelId;
	/** How words get their timestamps — forced alignment (per-word) or the source's own line timings. */
	syncMode: SyncModeId;
	/** `''` means "not declared": fall back to the env var, then to the address the TV was opened at. */
	joinOrigin: string;
	/** In flight at once — never a lifetime quota. */
	maxProcessesPerSinger: number;
}

/** No cap, and it INVERTS every ordinary comparison. See docs/SERVER.md#settings-scopes. */
export const PROCESSES_UNCAPPED = 0;
/** A bound on the NUMBER ITSELF; uncapped is spelled 0. See docs/SERVER.md#settings-scopes. */
export const MAX_PROCESSES_PER_SINGER_CEILING = 20;

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
	defaultFetcher: DEFAULT_FETCHER,
	defaultEngine: DEFAULT_ENGINE,
	defaultModel: DEFAULT_MODEL,
	enqueueUpgrade: false,
	upgradeEngine: 'roformer',
	upgradeModel: 'bs-roformer-1297',
	asrModel: DEFAULT_ASR_MODEL,
	syncMode: DEFAULT_SYNC_MODE,
	joinOrigin: '',
	maxProcessesPerSinger: 3
};

/** `null` when it cannot be an origin; `''` survives as `''`, so a caller can tell cleared from rejected. */
export function normalizeJoinOrigin(input: unknown): string | null {
	if (typeof input !== 'string') return null;
	const raw = input.trim();
	if (!raw) return '';
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
	return parsed.origin;
}

/** `null` = keep the current value. A negative is REJECTED rather than clamped, because 0 means uncapped. */
export function normalizeMaxProcesses(input: unknown): number | null {
	if (typeof input !== 'number' || !Number.isFinite(input)) return null;
	const n = Math.floor(input);
	if (n < 0 || n > MAX_PROCESSES_PER_SINGER_CEILING) return null;
	return n;
}

// Untrusted input degrades PER FIELD against the CURRENT value and is never rejected wholesale, so refusing
// one bad field cannot wipe an unrelated valid choice. BOTH layers state that rule as a TABLE rather than by
// hand, so each field is named once instead of three times. See docs/SERVER.md#contract-boundary.

/** One field's rule — the untrusted value and the CURRENT value in, the value to store out. */
type FieldRule<V> = (input: unknown, base: V) => V;

/** A rule for EVERY field of `S`: a new settings field is a compile error until it has one. */
type FieldRules<S> = { [K in keyof S]: FieldRule<S[K]> };

/** Walk the table. Key order follows the TABLE, so each one is declared in its interface's field order. */
function normalizeFields<S extends object>(rules: FieldRules<S>, input: Partial<S> | null | undefined, base: S): S {
	const out = {} as S;
	// Generic in the key, so each rule is applied at its own field's type with no cast.
	const applyRule = <K extends keyof S>(key: K): void => {
		out[key] = rules[key](input?.[key], base[key]);
	};
	for (const key of Object.keys(rules) as (keyof S)[]) applyRule(key);
	return out;
}

/** Keep the current value unless a registry guard admits the incoming one. */
function admitted<V>(isValid: (v: unknown) => v is V): FieldRule<V> {
	return (input, base) => (isValid(input) ? input : base);
}

/** The registry guards that take a `string` rather than an `unknown`: a non-string must read as "not
 *  admitted" instead of reaching a guard typed for strings. */
function stringId<V extends string>(isValid: (v: string) => v is V): (v: unknown) => v is V {
	return (v): v is V => typeof v === 'string' && isValid(v);
}

/** A bounded integer is CLAMPED rather than rejected, so a junk value still leaves a usable room. */
function clampedInt(lo: number, hi: number): FieldRule<number> {
	return (input, base) =>
		typeof input === 'number' && Number.isFinite(input) ? Math.min(hi, Math.max(lo, Math.round(input))) : base;
}

const keptBoolean: FieldRule<boolean> = (input, base) => (typeof input === 'boolean' ? input : base);

/** Rounded to a hundredth, the unit BOTH 0..1 room fractions use, so they compare alike. */
const fraction01: FieldRule<number> = (input, base) =>
	typeof input === 'number' && Number.isFinite(input) ? Math.round(Math.min(1, Math.max(0, input)) * 100) / 100 : base;

/** The two engine+model PAIRS are absent: a model is legal only against its own engine, so neither half can
 *  be judged as a field on its own. `normalizeGlobalSettings` validates each pair as a pair. */
const GLOBAL_FIELD_RULES: FieldRules<
	Omit<GlobalSettings, 'defaultEngine' | 'defaultModel' | 'upgradeEngine' | 'upgradeModel'>
> = {
	// A de-whitelisted or `local` fetcher degrades to the current value rather than being stored.
	defaultFetcher: admitted((v): v is FetcherId => typeof v === 'string' && isValidFetcher(v) && v !== 'local'),
	enqueueUpgrade: keptBoolean,
	asrModel: admitted(stringId(isValidAsrModel)),
	syncMode: admitted(stringId(isValidSyncMode)),
	// An unusable origin keeps the current one: re-enabling auto-detection puts `localhost` in the QR.
	joinOrigin: (input, base) => normalizeJoinOrigin(input) ?? base,
	maxProcessesPerSinger: (input, base) => normalizeMaxProcesses(input) ?? base
};

/** A caller patching existing settings MUST pass the current values as `base`.
 *  See docs/SERVER.md#contract-boundary. */
export function normalizeGlobalSettings(
	input: Partial<GlobalSettings> | null | undefined,
	base: GlobalSettings = DEFAULT_GLOBAL_SETTINGS
): GlobalSettings {
	// Each pair is validated together and falls back together — see `GLOBAL_FIELD_RULES`.
	const live =
		input && isLiveSelectable(input.defaultEngine ?? '', input.defaultModel ?? '')
			? { defaultEngine: input.defaultEngine!, defaultModel: input.defaultModel! }
			: { defaultEngine: base.defaultEngine, defaultModel: base.defaultModel };
	const upgrade =
		input && isValidSeparator(input.upgradeEngine ?? '', input.upgradeModel ?? '')
			? { upgradeEngine: input.upgradeEngine!, upgradeModel: input.upgradeModel! }
			: { upgradeEngine: base.upgradeEngine, upgradeModel: base.upgradeModel };
	return { ...live, ...upgrade, ...normalizeFields(GLOBAL_FIELD_RULES, input, base) };
}

// A setting belongs in the ROOM layer only when two rooms on one core could want different values.

/** How the TV shows song progress. */
export const TV_PROGRESS_STYLES = [
	{ id: 'card', label: 'In now singing card', note: 'Bar and countdown inside the now-singing card.' },
	{ id: 'corner', label: 'Minimal corner', note: 'Thin bar along the top with a time remaining pill.' },
	{ id: 'edge', label: 'Along bottom edge', note: 'Full-width bar on the bottom edge. No numbers.' },
	{ id: 'off', label: 'Off', note: 'No progress on the TV. The phone still shows it.' }
] as const;

export type TvProgressStyle = (typeof TV_PROGRESS_STYLES)[number]['id'];

const tvProgressRegistry = makeRegistry(TV_PROGRESS_STYLES);

/** @knipignore The registry's `get` half. A registry ships its accessor whether or not a caller has
 *  needed it yet — that rule is what stops a new entry being added with no way to resolve it — and
 *  `tests/unit/contract/barrel-surface.test.ts` pins it as public surface. */
export function getTvProgressStyle(id: string): (typeof TV_PROGRESS_STYLES)[number] | undefined {
	return tvProgressRegistry.get(id);
}

export function isTvProgressStyle(v: unknown): v is TvProgressStyle {
	return tvProgressRegistry.isValid(v);
}

/**
 * Type, registry and guards live in a leaf module because `PlaybackState` in types.ts also references the
 * type: holding it here makes types.ts import UP from the config layer and closes a cycle. Re-exported AND
 * imported locally, since a re-export binds no name here.
 */
import { isTvBackgroundStyle, type TvBackgroundStyle } from '../presentation/tv-background';
export {
	TV_BACKGROUND_STYLES,
	getTvBackgroundStyle,
	isTvBackgroundStyle,
	type TvBackgroundStyle
} from '../presentation/tv-background';

/** ADMISSION RULE: an entry must be a pure function of TIME and must not assert it draws the audio signal,
 *  since nothing on the TV reads it — which is why bars and a scope are absent. */
export const TV_VISUALIZERS = [
	{
		id: 'plasma',
		label: 'Plasma',
		note: 'Slow interference field, drifting. The demoscene classic.'
	},
	{
		id: 'starfield',
		label: 'Starfield',
		note: 'Flying through stars. What the old media players did while a track played.'
	},
	{ id: 'moire', label: 'Ripples', note: 'Concentric rings interfering with each other.' },
	{ id: 'lissajous', label: 'Phase curves', note: 'Looping curves that draw and redraw themselves.' }
] as const;

export type TvVisualizerId = (typeof TV_VISUALIZERS)[number]['id'];

const tvVisualizerRegistry = makeRegistry(TV_VISUALIZERS);

/** @knipignore The registry's `get` half — see `getTvProgressStyle` above for why it ships unused. */
export function getTvVisualizer(id: string): (typeof TV_VISUALIZERS)[number] | undefined {
	return tvVisualizerRegistry.get(id);
}

export function isTvVisualizer(v: unknown): v is TvVisualizerId {
	return tvVisualizerRegistry.isValid(v);
}

export interface RoomSettings {
	/** The ONE room setting that is not a render-time choice, so a write MUST re-derive the live queue. */
	queueOrder: QueueOrderId;
	/** Which progress treatment the TV renders. */
	tvProgressStyle: TvProgressStyle;
	/** What the TV paints behind the song. */
	tvBackgroundStyle: TvBackgroundStyle;
	/** Canonical 6-digit lowercase hex, read by BOTH the `solid` and `visualizer` backgrounds. Unbounded for
	 *  brightness, and the canonical shape is load-bearing. See docs/SERVER.md#colour-tiers. */
	tvBackgroundColor: string;
	/** 0..1. A LIGHTNESS control on the resolved colour, never an opacity layer over the video. */
	tvBackgroundDim: number;
	/** Ignored unless `tvBackgroundStyle === 'visualizer'`, but held across a switch away, so toggling the
	 *  visualizer off and on does not forget the choice. */
	tvVisualizer: TvVisualizerId;
	/** A separate boolean and NOT a `songIntroMs === 0` sentinel, which would destroy the dialled-in
	 *  duration on toggle off. */
	songIntroEnabled: boolean;
	/** How long the intro card holds, in ms (integer; surfaced in seconds). */
	songIntroMs: number;
	/** A `qualityRank` ceiling; `null` = none. LOWERS ONLY — see docs/SERVER.md#settings-scopes. */
	maxQualityRank: number | null;
	/** Read ONLY through `resolveLyricsPresentation`. See docs/SERVER.md#settings-scopes. */
	lyricsBall: LyricsBallStyleId;
	lyricsHighlight: LyricsHighlightId;
	/** How far ahead of the audio the highlight runs, in ms. See `DEFAULT_LYRICS_LEAD_MS`. */
	lyricsLeadMs: number;
	/** Read STRAIGHT off the room: routing it through the resolver would dilute what `clamped` means. */
	lyricsScalePct: number;
	lyricsFont: LyricsFontId;
	lyricsCase: LyricsCaseId;
	/** Lines of already-sung context above the current one, and of upcoming lyric below it. */
	lyricsLinesBefore: number;
	lyricsLinesAfter: number;
	/** 0..1 — how loud the original vocals sit when a song carries no per-song override. */
	guideLevelDefault: number;
	/** Whether this room pulls loud outlier songs DOWN toward the library level. Attenuate-only. */
	loudnessNormalization: boolean;
	/** Applies once the last socket drops AND the last pending song leaves the queue.
	 *  See docs/SERVER.md#membership-and-presence. */
	presenceGraceMinutes: number;
}

export const MIN_SONG_INTRO_MS = 500;
export const MAX_SONG_INTRO_MS = 10_000;
export const SONG_INTRO_STEP_MS = 500;

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
	queueOrder: DEFAULT_QUEUE_ORDER,
	tvProgressStyle: 'edge',
	tvBackgroundStyle: 'off',
	tvBackgroundColor: DEFAULT_STAGE_COLOR,
	tvBackgroundDim: DEFAULT_STAGE_DIM,
	tvVisualizer: 'plasma',
	songIntroEnabled: true,
	songIntroMs: 2500,
	maxQualityRank: null,
	lyricsBall: DEFAULT_LYRICS_BALL,
	lyricsHighlight: DEFAULT_LYRICS_HIGHLIGHT,
	lyricsLeadMs: DEFAULT_LYRICS_LEAD_MS,
	lyricsScalePct: DEFAULT_LYRICS_SCALE_PCT,
	lyricsFont: DEFAULT_LYRICS_FONT,
	lyricsCase: DEFAULT_LYRICS_CASE,
	lyricsLinesBefore: DEFAULT_LYRICS_LINES_BEFORE,
	lyricsLinesAfter: DEFAULT_LYRICS_LINES_AFTER,
	guideLevelDefault: 0,
	loudnessNormalization: false,
	presenceGraceMinutes: DEFAULT_PRESENCE_GRACE_MINUTES
};

/** The hold the TV applies: 0 when the intro is off, which the controller's hard-cut branch handles. */
export function effectiveSongIntroMs(room: Pick<RoomSettings, 'songIntroEnabled' | 'songIntroMs'>): number {
	return room.songIntroEnabled ? room.songIntroMs : 0;
}

/** EVERY field falls back to the CURRENT room value except `maxQualityRank`, which is the one deliberate
 *  exception and therefore the one rule that ignores its `base`. */
const ROOM_FIELD_RULES: FieldRules<RoomSettings> = {
	// An unlisted algorithm leaves the room on the one it is running, never swapping mid-party.
	queueOrder: admitted(isQueueOrder),
	tvProgressStyle: admitted(isTvProgressStyle),
	tvBackgroundStyle: admitted(isTvBackgroundStyle),
	tvBackgroundColor: normalizeStageColor,
	tvBackgroundDim: normalizeStageDim,
	tvVisualizer: admitted(isTvVisualizer),
	songIntroEnabled: keptBoolean,
	// 0 is deliberately BELOW the range: the boolean owns "off".
	songIntroMs: clampedInt(MIN_SONG_INTRO_MS, MAX_SONG_INTRO_MS),
	// THE EXCEPTION: an invalid or absent ceiling means NO ceiling, or the cap becomes unremovable.
	maxQualityRank: (input) =>
		typeof input === 'number' && Number.isFinite(input) && input > 0 ? Math.round(input) : null,
	lyricsBall: admitted(isValidLyricsBall),
	lyricsHighlight: admitted(isValidLyricsHighlight),
	// A NEGATIVE lead clamps to 0: a highlight BEHIND the audio reads as a broken overlay.
	lyricsLeadMs: clampedInt(0, MAX_LYRICS_LEAD_MS),
	lyricsScalePct: clampedInt(MIN_LYRICS_SCALE_PCT, MAX_LYRICS_SCALE_PCT),
	lyricsFont: admitted(isValidLyricsFont),
	lyricsCase: admitted(isValidLyricsCase),
	// 0 is a real choice for both: a room may want no history, or nothing revealed ahead.
	lyricsLinesBefore: clampedInt(0, MAX_LYRICS_LINES_BEFORE),
	lyricsLinesAfter: clampedInt(0, MAX_LYRICS_LINES_AFTER),
	// NOT nullable: this is the floor a per-song override inherits.
	guideLevelDefault: fraction01,
	loudnessNormalization: keptBoolean,
	// 0 IS a real choice (no grace at all), so it is a bound, not a rejected value.
	presenceGraceMinutes: clampedInt(MIN_PRESENCE_GRACE_MINUTES, MAX_PRESENCE_GRACE_MINUTES)
};

/** Coerce a partial/untrusted object to valid RoomSettings, falling back per-field. */
export function normalizeRoomSettings(
	input: Partial<RoomSettings> | null | undefined,
	base: RoomSettings = DEFAULT_ROOM_SETTINGS
): RoomSettings {
	return normalizeFields(ROOM_FIELD_RULES, input, base);
}

/** Both layers as one payload — what a client renders and what `queue:sync` carries. */
export interface EffectiveSettings {
	global: GlobalSettings;
	room: RoomSettings;
}

export const DEFAULT_EFFECTIVE_SETTINGS: EffectiveSettings = {
	global: DEFAULT_GLOBAL_SETTINGS,
	room: DEFAULT_ROOM_SETTINGS
};

/** The global default, or the best live-selectable pairing under the room's ceiling. Downward-only. */
export function resolveProcessSeparator(settings: EffectiveSettings): { engine: SeparatorEngineId; model: string } {
	const { defaultEngine, defaultModel } = settings.global;
	const cap = settings.room.maxQualityRank;
	if (cap === null || qualityRank(defaultEngine, defaultModel) <= cap) {
		return { engine: defaultEngine, model: defaultModel };
	}
	let best: { engine: SeparatorEngineId; model: string; rank: number } | null = null;
	for (const engine of SEPARATOR_ENGINES) {
		if (!engine.liveSelectable) continue;
		for (const model of engine.models) {
			const rank = qualityRank(engine.id, model.id);
			if (rank === 0 || rank > cap) continue;
			if (!best || rank > best.rank) best = { engine: engine.id, model: model.id, rank };
		}
	}
	return best ? { engine: best.engine, model: best.model } : { engine: DEFAULT_ENGINE, model: DEFAULT_MODEL };
}

/** What the TV should actually render for lyrics, after the room's request meets the box's reality. */
export interface LyricsPresentation {
	ball: LyricsBallStyleId;
	highlight: LyricsHighlightId;
	/** Seconds, because that is the unit the overlay and the position telemetry both work in. */
	leadSec: number;
	/** True when the room asked for what the words cannot support, so Settings can say so rather than show a
	 *  control that silently does nothing. With no song passed, only the fleet-wide half applies. */
	clamped: boolean;
}

/**
 * DOWNWARD-ONLY against TWO independent bounds of which only one is config; an absent `songTiming` means
 * UNKNOWN and does not clamp. Reads `needsWords`/`granularity` off the registries rather than testing style
 * ids, so adding a style stays a registry entry. See docs/SERVER.md#settings-scopes.
 */
export function resolveLyricsPresentation(
	settings: EffectiveSettings,
	songTiming?: LyricsTiming | null
): LyricsPresentation {
	const { lyricsBall, lyricsHighlight, lyricsLeadMs } = settings.room;
	const leadSec = lyricsLeadMs / 1000;
	const fleetProducesWords = getSyncMode(settings.global.syncMode)?.granularity === 'word';
	// Unknown reads as "do not clamp".
	const songHasWords = songTiming === undefined || songTiming === null || songTiming === 'word';
	const wordsAvailable = fleetProducesWords && songHasWords;
	if (wordsAvailable) return { ball: lyricsBall, highlight: lyricsHighlight, leadSec, clamped: false };

	// Line-only timings: degrade rather than render a mark with no anchor.
	const ballNeedsWords = getLyricsBallStyle(lyricsBall)?.needsWords ?? false;
	const highlightNeedsWords = getLyricsHighlight(lyricsHighlight)?.granularity === 'word';
	return {
		ball: ballNeedsWords ? 'off' : lyricsBall,
		// `line`, not `off`: the room still asked to be shown where it is, and line timing can honour that.
		highlight: highlightNeedsWords ? 'line' : lyricsHighlight,
		leadSec,
		clamped: ballNeedsWords || highlightNeedsWords
	};
}
