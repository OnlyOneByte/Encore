// Deployment and room CONFIGURATION — the root config layer of the whole system.
//
// `EffectiveSettings` (global + room) is what a client renders and what `queue:sync` carries, so this
// is the config contract every surface reads. It lived inside separators.ts, a file named for one
// sub-domain, which hid the root config type behind the separator registry; it lives here now so the
// name matches the role. separators.ts stays a pure registry and is imported from here.
//
// Two layers, split by WHO A SETTING BELONGS TO — see the `settings scopes` comment below.
//
// The public API is unchanged: index.ts re-exports this module, so `$lib/contract` consumers import
// exactly the same names they always did.

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
import { DEFAULT_FETCHER, isValidFetcher, type FetcherId } from '../cook/fetchers';
import { DEFAULT_STAGE_COLOR, DEFAULT_STAGE_DIM, normalizeStageColor, normalizeStageDim } from '../presentation/colors';
import { DEFAULT_PRESENCE_GRACE_MINUTES, MAX_PRESENCE_GRACE_MINUTES, MIN_PRESENCE_GRACE_MINUTES } from '../queue/membership';
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
// TYPE-ONLY, so this adds no runtime edge: `lyrics.ts` is deliberately dependency-free and importing
// a value from it here would be the first thing to compromise that. `LyricsTiming` is the per-song
// granularity fact `resolveLyricsPresentation`'s inner bound reads.
import type { LyricsTiming } from '../lyrics/lyrics';

// ── settings scopes ─────────────────────────────────────────────────────────
// Two layers, split by WHO A SETTING BELONGS TO:
//
//   GLOBAL — a property of this deployment and its worker fleet. An engine is only usable if some
//     connected worker advertises its capability — a hardware fact, not a party's. Two rooms on one
//     core cannot meaningfully disagree about whether a RoFormer worker exists, so per-room copies
//     would model a distinction that isn't real.
//
//   ROOM — a property of one party. Pacing and per-room policy: two rooms genuinely can want
//     different song-intro timing, and a busy room may want to cap cook quality to keep its queue
//     moving while the deployment default stays high.
//
// Both are authoritative SERVER state broadcast to clients (like presence), never phone-local
// preferences two devices could disagree about.

/**
 * Deployment-wide separator and cook policy. Writable by ANY joined singer via `PUT /api/settings`
 * (`settings:write-global`, which `can()` grants to every joined singer) — NOT operator-owned. This is
 * the owner's confirmed ruling (Q3, 2026-09-09): deployment-scoped settings stay open,
 * accepted. Published policy: docs/ux/05-concurrency.md § "Owner rulings".
 */
export interface GlobalSettings {
	/** Engine+model every new cook uses. Must be a `liveSelectable` pairing. */
	defaultEngine: SeparatorEngineId;
	defaultModel: string;
	/** When true, a completed cook enqueues a `stems-upgrade` re-separation from the retained raw
	 *  audio, swapping in a better instrumental without a re-download. */
	enqueueUpgrade: boolean;
	/** Engine+model the upgrade targets. May be an upgrade-only engine (e.g. ensemble). */
	upgradeEngine: SeparatorEngineId;
	upgradeModel: string;
	/**
	 * Which downloader acquires source audio. GLOBAL rather than per-room because it is a property of
	 * the box's binaries and credentials — a room cannot choose a fetcher its workers cannot run.
	 * `local` is never valid here: that is a property of an individual media, not a default.
	 */
	defaultFetcher: FetcherId;
	/**
	 * Which Whisper checkpoint the ASR tier transcribes sung vocals with. Global because the weights
	 * are a property of the box: they have to be downloaded once and held in RAM by the worker, so a
	 * room cannot pick a model its fleet cannot load.
	 */
	asrModel: AsrModelId;
	/**
	 * How words get their timestamps — forced alignment (per-word) or the source's own line timings.
	 * Global for the same reason: `forced` needs a worker that can load the wav2vec2 align model.
	 */
	syncMode: SyncModeId;
	/**
	 * Origin the TV advertises for joining, e.g. `http://192.168.1.20:3000`. `''` means "not declared":
	 * fall back to `ENCORE_PUBLIC_ORIGIN`, then to the address the TV itself was opened at.
	 *
	 * Global because it names the deployment's own address, which no single party owns. Settable at all
	 * because the TV's own URL is frequently NOT an address a phone can use — a WSL2 host reaches its
	 * service only via `localhost`, so the QR encodes `localhost` and every phone points at itself —
	 * and the operator who knows the real address is not always the one who can restart the process
	 * with an env var set.
	 */
	joinOrigin: string;
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
	defaultFetcher: DEFAULT_FETCHER,
	defaultEngine: DEFAULT_ENGINE,
	defaultModel: DEFAULT_MODEL,
	enqueueUpgrade: false,
	upgradeEngine: 'roformer',
	upgradeModel: 'bs-roformer-1297',
	asrModel: DEFAULT_ASR_MODEL,
	syncMode: DEFAULT_SYNC_MODE,
	// Empty, not a guess: an unset value defers to the env var and then to the request, both of which
	// are right more often than any literal this file could name.
	joinOrigin: ''
};

/**
 * Coerce an operator-supplied join address to a bare origin, or `null` if it cannot be one.
 *
 * `''` is a legitimate value meaning "not declared" and is returned as `''`, so a caller can tell
 * "cleared" from "rejected" — clearing the field must fall back to the env var, not be refused.
 *
 * Normalising through `URL.origin` drops any path, query or trailing slash, so a value pasted out of a
 * browser address bar (`http://10.0.0.5:3000/tv`) stores as the origin a phone needs. Only http and
 * https survive: the QR is opened by a phone browser, and the same string is what the cookie and
 * fetch paths assume.
 */
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

/** Coerce a partial/untrusted object to valid GlobalSettings, falling back per-field. Used by the
 *  write API so a bad client payload degrades to defaults rather than persisting garbage.
 *
 *  `base` is what an invalid field falls back TO. Callers patching existing settings pass the current
 *  values, so rejecting one bad field cannot silently wipe an unrelated valid choice — sending an
 *  upgrade-only engine as the live default must not also reset a previously-chosen model. */
export function normalizeGlobalSettings(
	input: Partial<GlobalSettings> | null | undefined,
	base: GlobalSettings = DEFAULT_GLOBAL_SETTINGS
): GlobalSettings {
	const d = base;
	const live =
		input && isLiveSelectable(input.defaultEngine ?? '', input.defaultModel ?? '')
			? { defaultEngine: input.defaultEngine!, defaultModel: input.defaultModel! }
			: { defaultEngine: d.defaultEngine, defaultModel: d.defaultModel };
	const upgrade =
		input && isValidSeparator(input.upgradeEngine ?? '', input.upgradeModel ?? '')
			? { upgradeEngine: input.upgradeEngine!, upgradeModel: input.upgradeModel! }
			: { upgradeEngine: d.upgradeEngine, upgradeModel: d.upgradeModel };
	// A de-whitelisted or `local` fetcher degrades to the default rather than being stored: `local`
	// describes one media's bytes, so accepting it here would mean "download nothing, ever".
	const fetcher =
		input?.defaultFetcher && isValidFetcher(input.defaultFetcher) && input.defaultFetcher !== 'local'
			? input.defaultFetcher
			: d.defaultFetcher;
	return {
		...live,
		...upgrade,
		defaultFetcher: fetcher,
		enqueueUpgrade: typeof input?.enqueueUpgrade === 'boolean' ? input.enqueueUpgrade : d.enqueueUpgrade,
		// Same per-field degrade rule: a model or mode that has been de-whitelisted between releases
		// falls back rather than being served, and rejecting it cannot disturb the other choice.
		asrModel: input?.asrModel && isValidAsrModel(input.asrModel) ? input.asrModel : d.asrModel,
		syncMode: input?.syncMode && isValidSyncMode(input.syncMode) ? input.syncMode : d.syncMode,
		// A value that is not a usable origin keeps the current one rather than clearing it: silently
		// falling back to auto-detection is how a party ends up with `localhost` in the QR again.
		joinOrigin: normalizeJoinOrigin(input?.joinOrigin) ?? d.joinOrigin
	};
}

// ── room layer ──────────────────────────────────────────────────────────────
// One party's own policy. Kept deliberately small: a setting belongs here only when two rooms on one
// core could genuinely want different values.

/**
 * How the TV shows song progress. Room-scoped because it is a staging choice for one party's screen,
 * not a property of the deployment.
 *
 * A registry rather than a bare union so the phone can render the picker from one source and a new
 * style cannot be added without a label.
 */
export const TV_PROGRESS_STYLES = [
	{ id: 'card', label: 'In now singing card', note: 'Bar and countdown inside the now-singing card.' },
	{ id: 'corner', label: 'Minimal corner', note: 'Thin bar along the top with a time remaining pill.' },
	{ id: 'edge', label: 'Along bottom edge', note: 'Full-width bar on the bottom edge. No numbers.' },
	{ id: 'off', label: 'Off', note: 'No progress on the TV. The phone still shows it.' }
] as const;

export type TvProgressStyle = (typeof TV_PROGRESS_STYLES)[number]['id'];

const tvProgressRegistry = makeRegistry(TV_PROGRESS_STYLES);

export function getTvProgressStyle(id: string): (typeof TV_PROGRESS_STYLES)[number] | undefined {
	return tvProgressRegistry.get(id);
}

export function isTvProgressStyle(v: unknown): v is TvProgressStyle {
	return tvProgressRegistry.isValid(v);
}

/**
 * What the TV paints behind the song. Its type, registry and guards live in `./tv-background` — a
 * leaf module — because `PlaybackState` in types.ts also references the type, and keeping it here made
 * types.ts import UP from the config layer and closed a dependency cycle (see tv-background.ts). It is
 * re-exported so `./settings` consumers (e.g. events.ts) still import these names from here unchanged;
 * the type and guard are also imported locally, because a re-export does not bind them in this module.
 */
import { isTvBackgroundStyle, type TvBackgroundStyle } from '../presentation/tv-background';
export {
	TV_BACKGROUND_STYLES,
	getTvBackgroundStyle,
	isTvBackgroundStyle,
	type TvBackgroundStyle
} from '../presentation/tv-background';

/**
 * Which visualizer the `visualizer` background runs. Read only when
 * `tvBackgroundStyle === 'visualizer'`.
 *
 * ── Why these four and not bars or a scope ──
 *
 * Every entry here is a function of TIME. None of them claims to be showing the audio signal, and
 * that is the selection rule, not an accident of what was easy.
 *
 * Spectrum bars and an oscilloscope are the obvious two omissions. They are omitted because they
 * ASSERT they are drawing the signal, and nothing on this surface is reading it: there is no
 * AudioContext on the TV today. Drawing them from a timer would be the same defect the lyrics overlay
 * refuses by name — "a lie dressed as precision, animated made-up sub-word detail" (LyricsOverlay's
 * comment on why a word-fill sweep was rejected). A plasma asserts nothing, so a plasma can be
 * time-driven honestly.
 *
 * When real audio analysis lands, `bars` and `scope` join this registry AND every entry here gains
 * modulation. Until then the picker must not offer a display that lies about its input.
 */
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

export function getTvVisualizer(id: string): (typeof TV_VISUALIZERS)[number] | undefined {
	return tvVisualizerRegistry.get(id);
}

export function isTvVisualizer(v: unknown): v is TvVisualizerId {
	return tvVisualizerRegistry.isValid(v);
}

export interface RoomSettings {
	/**
	 * Which ordering algorithm decides who sings next. Room-scoped because it is a HOUSE RULE: a living
	 * room wants a rotation, a bar with a sign-up sheet wants first-come-first-served, and two parties
	 * on one core can genuinely disagree. The registry lives in queue-order.ts.
	 *
	 * Unlike every other room setting this one is not a render-time choice: `rotationSeq` is stored on
	 * each entry, so a write that changes it must re-derive the live queue and broadcast (see the room
	 * settings endpoint). It never interrupts the song already playing — ordering ranks only `queued`
	 * entries.
	 */
	queueOrder: QueueOrderId;
	/** Which progress treatment the TV renders. */
	tvProgressStyle: TvProgressStyle;
	/** What the TV paints behind the song. Room-scoped: it is one party's staging taste. */
	tvBackgroundStyle: TvBackgroundStyle;
	/**
	 * The stage's colour, as canonical 6-digit lowercase hex. Read by BOTH the `solid` background and
	 * the `visualizer` one — they need the same thing (the room's chosen colour), so they share the
	 * field rather than each carrying their own; the visualizer takes its palette's hue from it through
	 * `hueOfColor`.
	 *
	 * A REAL COLOUR, not a hue angle — the field changed type. It was an angle, quantised to the wheel step and
	 * rendered at a pinned stage lightness by `stageHueToHex`, so that no room could produce a field
	 * bright enough to wash out the word-timed lyric reel. That bound is retired: the reel now carries
	 * its own `-webkit-text-stroke` outline (`b764d92`), which protects the words on any field —
	 * including over a music video, which a bound on the stage colour could never reach. A room may
	 * pick white.
	 *
	 * What the change KEEPS is the pin's other stated reason, which was never about brightness: the
	 * value is normalised to one canonical hex shape, because it is interpolated straight into a `style`
	 * attribute and the `#rgb`-vs-`#rrggbb` trap silently dropped the singer halo once already.
	 */
	tvBackgroundColor: string;
	/**
	 * How far the stage background is dimmed toward black, as a 0..1 fraction: 0 shows the resolved
	 * stage colour at full strength, 1 pulls it all the way to black. Room-scoped like the colour it
	 * dims — one party's staging taste.
	 *
	 * Piece 3 of the stage-colour change (owner ruling Q2 = A, 2026-09-07): "Dim the stage colour toward black — today's
	 * geometry, no new layer." It is a LIGHTNESS control, not an opacity layer over the video: the
	 * stage sits behind the video on a black floor, so darkening it toward black reveals nothing of the
	 * video and adds no layer. Applied to the concrete colour the stage resolves to — see
	 * `dimTowardBlack` and `stageBackgroundCss`.
	 *
	 * Ships at 0, which reproduces today's TV exactly (no dim), so the feature is opt-in.
	 */
	tvBackgroundDim: number;
	/**
	 * Which visualizer runs when `tvBackgroundStyle === 'visualizer'`. Ignored otherwise.
	 *
	 * Held even while another background is selected, so switching to the visualizer and back does not
	 * forget the choice — the same reason `tvBackgroundColor` survives a switch away from `solid`.
	 */
	tvVisualizer: TvVisualizerId;
	/**
	 * Whether the TV shows the song intro card (title, artist, singer) between songs. Off = a pure
	 * gapless hard-cut.
	 *
	 * A separate boolean rather than the 0-means-off sentinel this field used to be: a sentinel
	 * DESTROYS the duration when you toggle off, so turning the intro back on lost the timing you had
	 * dialled in.
	 */
	songIntroEnabled: boolean;
	/**
	 * How long the intro card holds, in ms. Stored in ms (integer, no float rounding) and surfaced in
	 * seconds. Per-room because pacing is a property of the party, not the deployment.
	 */
	songIntroMs: number;
	/**
	 * Optional per-room ceiling on cook quality, as a `qualityRank`. A busy room can cap cooks to keep
	 * its queue moving while the deployment default stays high. `null` = no ceiling, use the global
	 * default. A ceiling can only ever LOWER quality: the global setting is already bounded by what the
	 * worker fleet can run, so a room must not be able to request an engine no worker advertises.
	 */
	maxQualityRank: number | null;
	/**
	 * How the TV marks the word being sung, and how the current lyric is lit. Room-scoped for the same
	 * reason `tvProgressStyle` is: staging choices for one party's screen, not properties of the box.
	 *
	 * Both are bounded ABOVE by the global `syncMode`: a word-level treatment needs word timings to
	 * exist, and under `syncMode: 'lines'` they do not. Read them through `resolveLyricsPresentation`
	 * rather than directly, so the clamp is applied in exactly one place.
	 */
	lyricsBall: LyricsBallStyleId;
	lyricsHighlight: LyricsHighlightId;
	/** How far ahead of the audio the highlight runs, in ms. See `DEFAULT_LYRICS_LEAD_MS`. */
	lyricsLeadMs: number;
	/**
	 * The reel's TYPE, as opposed to the marks drawn on it. Unlike `lyricsBall`/`lyricsHighlight` these
	 * are NOT clamped against the global sync mode — size, font, case and row counts do not depend on
	 * whether word timings exist — so they are read straight off the room rather than through
	 * `resolveLyricsPresentation`. Routing them through it would dilute what its `clamped` flag means.
	 */
	lyricsScalePct: number;
	lyricsFont: LyricsFontId;
	lyricsCase: LyricsCaseId;
	/** Lines of already-sung context above the current one, and of upcoming lyric below it. */
	lyricsLinesBefore: number;
	lyricsLinesAfter: number;
	/**
	 * The room's default GUIDING TRACK level (0..1) — how loud the original vocals sit under the
	 * instrumental when a song carries no per-song override. Per-room because it is a property of the
	 * party: a crowd doing songs it half-knows wants a permanent faint guide, a confident room wants 0.
	 *
	 * Ships at 0, which reproduces today's behaviour exactly (pure karaoke), so the feature is opt-in.
	 */
	guideLevelDefault: number;
	/**
	 * Whether this room pulls loud outlier songs DOWN toward the library level. Room-scoped
	 * because it is a property of one party's audio taste, and open to any joined singer per the owner's
	 * Q3 = B ruling (room settings need no capability gate).
	 *
	 * When on, a song whose measured `songProfile.loudnessLufs` is more than `LOUDNESS_CLAMP_N_DB`
	 * above the library median is attenuated to `median + N` at playback — only loud outliers, and only
	 * once at least `LOUDNESS_MEASURED_FLOOR` songs carry a measured level. See
	 * `loudness-normalization.ts` for the full ruling. Attenuate-only: a quiet song is never brought up.
	 *
	 * Ships at `false`, which reproduces today's TV exactly (every song at unity), so the feature is
	 * opt-in — the same discipline as `guideLevelDefault` and `tvBackgroundDim`.
	 */
	loudnessNormalization: boolean;
	/**
	 * How long a singer stays in the room after their last socket drops AND their last pending song
	 * leaves the queue. Per-room because it is a property of the party: a long evening where people
	 * pocket their phones wants a generous window, a kiosk wants none.
	 */
	presenceGraceMinutes: number;
}

export const MIN_SONG_INTRO_MS = 500;
export const MAX_SONG_INTRO_MS = 10_000;
export const SONG_INTRO_STEP_MS = 500;

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
	queueOrder: DEFAULT_QUEUE_ORDER,
	/*
	 * `edge` — a hairline along the bottom of the panel — rather than `card`.
	 *
	 * `card` meant "the bar and the clock live inside the now-singing card", and there is no card any
	 * more: the now-singing block is plain text on the backdrop, because a filled panel covered the
	 * room's chosen background. `card` still WORKS (the block renders the clock row inline, so the
	 * setting keeps its meaning rather than silently becoming something else) but it is no longer the
	 * right default: the edge hairline states elapsed time without adding a numeric row to a block whose
	 * whole point is that it is quiet.
	 *
	 * Existing rooms are untouched — this is the default for a room that has never chosen.
	 */
	tvProgressStyle: 'edge',
	// `off` so an existing box looks byte-identical after the migration: today's TV is plain black
	// behind the song, and a default that changed the stage would be a surprise, not a feature.
	tvBackgroundStyle: 'off',
	// 240° — the blue that tested cleanest against the pink active word — is where the old hue slider
	// started, and `#001d31` is exactly what `stageHueToHex(240)` rendered it as, so the change from
	// an angle to a colour leaves an existing box looking identical. Only used once a room picks `solid`
	// or `visualizer`, so this is the starting point of the picker rather than something anyone sees by
	// default.
	tvBackgroundColor: DEFAULT_STAGE_COLOR,
	// 0 — no dim, so an existing box looks byte-identical after the migration. Only bites once a room
	// moves the slider, matching the colour above (unseen until a room picks `solid`/`visualizer`).
	tvBackgroundDim: DEFAULT_STAGE_DIM,
	// Plasma is the one every old media player had, so it is the least surprising thing to find running
	// the first time a room turns the visualizer on.
	tvVisualizer: 'plasma',
	songIntroEnabled: true,
	songIntroMs: 2500,
	maxQualityRank: null,
	// These three reproduce the TV's previously-hardcoded behaviour exactly, so adding the settings
	// changes nothing until someone opens Settings.
	lyricsBall: DEFAULT_LYRICS_BALL,
	lyricsHighlight: DEFAULT_LYRICS_HIGHLIGHT,
	lyricsLeadMs: DEFAULT_LYRICS_LEAD_MS,
	lyricsScalePct: DEFAULT_LYRICS_SCALE_PCT,
	lyricsFont: DEFAULT_LYRICS_FONT,
	lyricsCase: DEFAULT_LYRICS_CASE,
	lyricsLinesBefore: DEFAULT_LYRICS_LINES_BEFORE,
	lyricsLinesAfter: DEFAULT_LYRICS_LINES_AFTER,
	guideLevelDefault: 0,
	// false — every song at unity, byte-identical to today's TV. Opt-in like guideLevelDefault.
	loudnessNormalization: false,
	presenceGraceMinutes: DEFAULT_PRESENCE_GRACE_MINUTES
};

/**
 * The hold the TV should actually apply. Keeps the gapless controller untouched: its existing
 * `ms === 0` hard-cut branch still does the work when the intro is switched off.
 */
export function effectiveSongIntroMs(room: Pick<RoomSettings, 'songIntroEnabled' | 'songIntroMs'>): number {
	return room.songIntroEnabled ? room.songIntroMs : 0;
}

/** Coerce a partial/untrusted object to valid RoomSettings, falling back per-field. */
export function normalizeRoomSettings(
	input: Partial<RoomSettings> | null | undefined,
	base: RoomSettings = DEFAULT_ROOM_SETTINGS
): RoomSettings {
	// Falls back to the CURRENT room values, not hardcoded defaults: rejecting one invalid field must
	// not discard an unrelated choice the room already made.
	const d = base;
	// One combinator for every bounded integer: clamp a finite number into [lo, hi] (rounded), else fall
	// back. Clamped rather than rejected — a nonsensical value should still leave a usable room, and
	// every bound has a stated reason (a legibility floor, a row count past which the type must shrink,
	// an intro that unbounded would strand the TV between songs). Declared FIRST so the fields that used
	// to hand-inline this same expression (songIntroMs, lyricsLeadMs, presenceGraceMinutes) share it.
	const clampInt = (v: unknown, lo: number, hi: number, fallback: number) =>
		typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
	// Clamped rather than rejected: a nonsensical value should still yield a usable room, and an
	// unbounded intro would strand the TV between songs. 0 is NOT in range — the toggle owns "off", so
	// leaving a zero here would be a second way to say the same thing.
	const songIntroMs = clampInt(input?.songIntroMs, MIN_SONG_INTRO_MS, MAX_SONG_INTRO_MS, d.songIntroMs);
	const enabled = input?.songIntroEnabled;
	const songIntroEnabled = typeof enabled === 'boolean' ? enabled : d.songIntroEnabled;
	const cap = input?.maxQualityRank;
	// EXCEPTION to the fall-back-to-base contract above: an invalid or absent ceiling means NO ceiling,
	// NOT the room's current cap. "No limit" (settings/+page.svelte:594) sends null and must actually
	// clear — falling back to d.maxQualityRank here would make the cap permanently unremovable.
	const maxQualityRank = typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? Math.round(cap) : null;
	const style = input?.tvProgressStyle;
	const tvProgressStyle = isTvProgressStyle(style) ? style : d.tvProgressStyle;
	// Reject-to-current, like tvProgressStyle: a de-whitelisted algorithm must leave the room on the one
	// it is already running rather than silently swapping the house rule mid-party.
	const orderId = input?.queueOrder;
	const queueOrder = isQueueOrder(orderId) ? orderId : d.queueOrder;
	const ball = input?.lyricsBall;
	const lyricsBall = isValidLyricsBall(ball) ? ball : d.lyricsBall;
	const highlight = input?.lyricsHighlight;
	const lyricsHighlight = isValidLyricsHighlight(highlight) ? highlight : d.lyricsHighlight;
	// Clamped, like the song intro and for the same reason: a lead of 30s is nonsense but should still
	// leave a usable room. A NEGATIVE lead is clamped to 0 rather than honoured — running the highlight
	// BEHIND the audio has no use case and reads as the overlay being broken.
	const lyricsLeadMs = clampInt(input?.lyricsLeadMs, 0, MAX_LYRICS_LEAD_MS, d.lyricsLeadMs);
	const lyricsScalePct = clampInt(input?.lyricsScalePct, MIN_LYRICS_SCALE_PCT, MAX_LYRICS_SCALE_PCT, d.lyricsScalePct);
	// Zero is a legitimate value for both: a room may want no history, or nothing revealed ahead.
	const lyricsLinesBefore = clampInt(input?.lyricsLinesBefore, 0, MAX_LYRICS_LINES_BEFORE, d.lyricsLinesBefore);
	const lyricsLinesAfter = clampInt(input?.lyricsLinesAfter, 0, MAX_LYRICS_LINES_AFTER, d.lyricsLinesAfter);
	const font = input?.lyricsFont;
	const lyricsFont = isValidLyricsFont(font) ? font : d.lyricsFont;
	const textCase = input?.lyricsCase;
	const lyricsCase = isValidLyricsCase(textCase) ? textCase : d.lyricsCase;
	const bg = input?.tvBackgroundStyle;
	const tvBackgroundStyle = isTvBackgroundStyle(bg) ? bg : d.tvBackgroundStyle;
	// A COLOUR now, not an angle. Normalised to canonical hex and deliberately NOT gated on
	// brightness: the pin that used to bound it was replaced by the lyric reel's own stroke, so
	// a room may pick white. Unparseable input keeps the colour the room already chose rather than
	// resetting it — the same rule every other field here follows.
	const tvBackgroundColor = normalizeStageColor(input?.tvBackgroundColor, d.tvBackgroundColor);
	// A 0..1 dim fraction, clamped like guideLevelDefault (rounded to a hundredth) — the two 0..1 room
	// fractions store and compare the same way. A junk write keeps the room's current dim, not the
	// default, matching every other field here.
	const tvBackgroundDim = normalizeStageDim(input?.tvBackgroundDim, d.tvBackgroundDim);
	// Clamped, like the song intro: a room default outside 0..1 should still yield a usable room. Note
	// this one is NOT nullable — the room default is the floor the per-song override falls back to, so
	// there is nothing below it to inherit from. A junk write keeps the room's current value.
	// Clamped like the intro: a nonsensical window should still yield a usable room. 0 IS a real choice
	// here (no grace once your songs are done), so it is a bound rather than a rejected value.
	const presenceGraceMinutes = clampInt(
		input?.presenceGraceMinutes,
		MIN_PRESENCE_GRACE_MINUTES,
		MAX_PRESENCE_GRACE_MINUTES,
		d.presenceGraceMinutes
	);
	const gl = input?.guideLevelDefault;
	const guideLevelDefault =
		typeof gl === 'number' && Number.isFinite(gl)
			? Math.round(Math.min(1, Math.max(0, gl)) * 100) / 100
			: d.guideLevelDefault;
	// A plain boolean toggle, like songIntroEnabled: a boolean is honoured, anything else keeps the
	// room's current choice rather than resetting the feature.
	const ln = input?.loudnessNormalization;
	const loudnessNormalization = typeof ln === 'boolean' ? ln : d.loudnessNormalization;
	const viz = input?.tvVisualizer;
	const tvVisualizer = isTvVisualizer(viz) ? viz : d.tvVisualizer;
	return {
		queueOrder,
		tvProgressStyle,
		tvBackgroundStyle,
		tvBackgroundColor,
		tvBackgroundDim,
		tvVisualizer,
		songIntroEnabled,
		songIntroMs,
		maxQualityRank,
		lyricsBall,
		lyricsHighlight,
		lyricsLeadMs,
		lyricsScalePct,
		lyricsFont,
		lyricsCase,
		lyricsLinesBefore,
		lyricsLinesAfter,
		guideLevelDefault,
		loudnessNormalization,
		presenceGraceMinutes
	};
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

/**
 * The engine+model a cook in this room should actually use. The global default wins unless the room
 * set a lower ceiling, in which case the best live-selectable pairing at or under that ceiling is
 * chosen. The cap is downward-only (see `RoomSettings.maxQualityRank`).
 */
export function resolveCookSeparator(settings: EffectiveSettings): { engine: SeparatorEngineId; model: string } {
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
	/**
	 * True when the room asked for something the words on screen cannot support, so what is returned
	 * is a degraded substitute. The Settings page says so rather than showing a picker whose value is
	 * silently ignored — a control that does nothing is worse than one that is absent.
	 *
	 * TWO bounds can raise this (see `resolveLyricsPresentation`): the deployment's sync mode, and the
	 * playing song's own timing granularity. The Settings page reads it for the FIRST only, because it
	 * describes the deployment with no song in hand and so passes none.
	 */
	clamped: boolean;
}

/**
 * Resolve the room's lyrics presentation against what can actually be drawn.
 *
 * The clamp is DOWNWARD-ONLY, the same shape as `resolveCookSeparator`'s quality ceiling and for the
 * same kind of reason: a room must not be able to request something no cook produced. Here the bound
 * is timing granularity — with no per-word timestamps a word-level highlight has nothing to light and
 * a marker has no word to sit on.
 *
 * THERE ARE TWO BOUNDS, AND ONLY ONE OF THEM IS CONFIG.
 *
 *   OUTER — `global.syncMode`. What the worker fleet is configured to PRODUCE. A fleet-wide fact.
 *   INNER — `songTiming`, this song's chosen candidate's `timing`. What this song actually HAS.
 *
 * The outer bound alone was wrong in one direction, and it is the direction that matters. `syncMode:
 * 'lines'` does imply no word stamps anywhere, so that half held; but the converse does not follow —
 * under the default word-level mode a song whose winning candidate came from a line-level source (a
 * synced LRCLIB record that was never force-aligned, or an alignment that was refused as unusable and
 * degraded to line sync) is still line-only. No clamp fired, so the TV drew the word treatment over a
 * doc with an empty `words[]`: the current line lost the accent that says "sing this one" and painted
 * plain white, indistinguishable from a line with no highlight configured at all.
 *
 * A PER-ITEM QUESTION MUST NOT BE ANSWERED FROM A GLOBAL SETTING, even when the global is right.
 *
 * `songTiming` absent or null means UNKNOWN, and unknown deliberately does NOT clamp: an artifact
 * written before candidate tracking has no recorded granularity, and most such artifacts DO carry
 * word timings because the aligner is what produced them. Clamping on unknown would strip working
 * word highlighting off every legacy song to fix a case that is not theirs. This is the same stance
 * `isAutoTranscribed` takes on unknown provenance — we do not assert either way — and the overlay
 * still degrades per-line on its own, because it only renders word spans for a line that has words.
 *
 * Deliberately reads `needsWords`/`granularity` off the registries instead of testing style ids, so
 * adding a style is a registry entry and not an edit here.
 */
export function resolveLyricsPresentation(
	settings: EffectiveSettings,
	songTiming?: LyricsTiming | null
): LyricsPresentation {
	const { lyricsBall, lyricsHighlight, lyricsLeadMs } = settings.room;
	const leadSec = lyricsLeadMs / 1000;
	const fleetProducesWords = getSyncMode(settings.global.syncMode)?.granularity === 'word';
	// Unknown (absent/null) reads as "do not clamp" — see the note above. Every KNOWN value other
	// than 'word' ('line', and 'none' which has nothing to sync at all) bounds the room downward.
	const songHasWords = songTiming === undefined || songTiming === null || songTiming === 'word';
	const wordsAvailable = fleetProducesWords && songHasWords;
	if (wordsAvailable) return { ball: lyricsBall, highlight: lyricsHighlight, leadSec, clamped: false };

	// Line-only timings: degrade rather than render a mark with no anchor.
	const ballNeedsWords = getLyricsBallStyle(lyricsBall)?.needsWords ?? false;
	const highlightNeedsWords = getLyricsHighlight(lyricsHighlight)?.granularity === 'word';
	return {
		ball: ballNeedsWords ? 'off' : lyricsBall,
		// Falls to `line`, not `off`: the room still asked to be shown where it is, and line-level
		// timing can honour that. Turning the highlight off entirely would discard a choice the room
		// made for a reason unrelated to granularity.
		highlight: highlightNeedsWords ? 'line' : lyricsHighlight,
		leadSec,
		clamped: ballNeedsWords || highlightNeedsWords
	};
}
