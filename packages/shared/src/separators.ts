// @encore/shared — the pluggable stem-separator registry. SINGLE SOURCE OF TRUTH for both the
// SERVER (validates an engine+model pairing before enqueueing a cook) and the PHONE UI (renders the
// engine → model dropdowns). The worker has its own registry that actually RUNS each engine; this
// module is only the contract — ids, whitelist, rules — so the three sides cannot drift.
//
// TWO AXES, kept deliberately separate (this is the whole design):
//   • ENGINE  — a distinct inference implementation. Adding one is real code AND a worker
//               `capability` the job is routed by (capabilities.includes(jobType)). Rare.
//   • MODEL   — a checkpoint WITHIN an engine, addressed by a stable token here and resolved to a
//               concrete checkpoint by the worker engine. Adding one is a whitelist edit, no code.
//
// Whitelisted on purpose (Angelo, 2026-09-03): the phone can only pick from this fixed set, so a tap
// can never trigger an arbitrary multi-hundred-MB checkpoint download onto the shared box. Widening
// to arbitrary Hugging Face ids is a deliberate future toggle, not the default.

import { DEFAULT_FETCHER, isValidFetcher, type FetcherId } from './fetchers';
import { SINGER_HUE_STEP } from './colors';
import {
	DEFAULT_PRESENCE_GRACE_MINUTES,
	MAX_PRESENCE_GRACE_MINUTES,
	MIN_PRESENCE_GRACE_MINUTES
} from './membership';
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
} from './lyrics-engines';

export type SeparatorEngineId = 'demucs' | 'roformer' | 'ensemble';

/**
 * What a checkpoint COSTS to run, measured rather than guessed.
 *
 * Every field here was benchmarked on the reference box (32-core Graviton 3, CPU, aarch64) on
 * 2026-09-03 — see `REFERENCE_BOX`. Three results drove the shape of this type:
 *
 *   • Wall-clock is LINEAR in `overlap`. Dropping a model from 4 to 2 took a 24s clip from 253s to
 *     138s (1.83×) with the per-window cost unchanged, because overlap is purely how many times each
 *     second of audio is recomputed and blended.
 *   • `cpuPrecision` REVERSES per checkpoint. bf16 was 1.6× faster than fp32 on bs-roformer-1297
 *     (26.59s → 16.55s per window) but 1.4–1.8× SLOWER on the 8s-window mel-band models. So there is
 *     no global "use bf16" switch to set; it is a per-checkpoint measurement or it is wrong.
 *   • Parameter count does not predict cost. A 228M-param mel-band model ran 5.2× faster per window
 *     than the 160M-param bs-roformer-1297, because `depth` and `dim` dominate. Nothing here may be
 *     inferred from checkpoint size.
 */
export interface SeparatorCost {
	/**
	 * MEASURED seconds of wall-clock per second of song, on the reference box, at this model's
	 * `overlap` and `cpuPrecision`. htdemucs is 0.29 (a 2:51 song in 50s); bs-roformer-1297 is 8.28.
	 *
	 * A RATIO for UI estimation ("this will take about four minutes"), never a gate. Scale it for
	 * other hardware via `estimateCookSeconds`'s `hardwareFactor` — do not treat it as absolute.
	 */
	rtFactor: number;
	/**
	 * Number of overlapping prediction windows, as an INTEGER COUNT (MDXC/RoFormer semantics).
	 *
	 * Absent on demucs models on purpose: demucs's overlap is a 0–1 FRACTION (0.25). Unifying two
	 * different meanings under one field name is how a `4` eventually gets passed where `0.25`
	 * belongs, so the field is simply not present where that meaning does not hold.
	 *
	 * Hardware-independent — it is a redundancy multiplier, not an execution detail — which is why it
	 * lives with the model here rather than with the worker's hardware backend.
	 */
	overlap?: number;
	/**
	 * Precision the worker should run this checkpoint at ON A CPU BOX. Named for the CPU deliberately:
	 * it is a (checkpoint × hardware) fact, not a property of the checkpoint alone. A GPU backend
	 * overrides it — fp16 is the lever on Arc XMX and Apple MPS, while on CPU fp16 measured 6.5×
	 * SLOWER than fp32 (179s vs 27.7s per window) because there are no fp16 CPU kernels.
	 */
	cpuPrecision: 'fp32' | 'bf16';
	/** Whether the numbers above were benchmarked on the reference box or reasoned about. An
	 *  `estimated` cost is honest guidance for the UI but must never be cited as evidence. */
	provenance: 'measured' | 'estimated';
}

export interface SeparatorModel {
	/** Stable token stored in JobParams.model and room settings. NEVER a raw checkpoint filename — the
	 *  worker maps this token to a concrete checkpoint, so upstream can re-host or rename it without
	 *  touching stored jobs or settings. */
	id: string;
	/** Human label for the phone dropdown. */
	label: string;
	/** One-line "why pick this" shown under the label. */
	note: string;
	/** Measured cost of running this checkpoint. See `SeparatorCost`. */
	cost: SeparatorCost;
}

export interface SeparatorEngine {
	id: SeparatorEngineId;
	label: string;
	/** The worker CAPABILITY a worker must advertise to run this engine; dispatch routes a stems job
	 *  via capabilities.includes(capability). A `demucs`-only worker never receives a `roformer` cook,
	 *  so engines can live on different boxes or images. */
	capability: string;
	/** Whitelisted, ordered best-effort by quality. First entry is the engine's default model. */
	models: SeparatorModel[];
	/** Upgrade-tier engines are heavy/slow and MUST NOT be selectable as the live default — valid only
	 *  as the target of a `stems-upgrade`. `ensemble` runs N models, so it is upgrade-only. */
	liveSelectable: boolean;
	/** Rough guidance for the UI, not a hard gate. */
	speed: 'fast' | 'medium' | 'slow';
}

// ── the registry ────────────────────────────────────────────────────────────────
/**
 * The box every `SeparatorCost.rtFactor` below was measured on, recorded so a future reader can tell
 * whether a number still applies to the hardware in front of them. Encore's three known targets sit
 * within a small factor of each other, which is exactly why the ratio is worth writing down: the
 * deploy box's Arc A380 is ~2× this at fp32 and ~4× at fp16, and an M1 Pro's GPU is ~2.5×/~5×.
 * Neither is the 10–40× a CUDA card would give, so no engine here becomes "fast" by moving hardware.
 */
export const REFERENCE_BOX = '32-core Graviton 3 (Neoverse V1, aarch64), CPU only, 2026-09-03';

export const SEPARATOR_ENGINES: readonly SeparatorEngine[] = [
	{
		id: 'demucs',
		label: 'Demucs',
		capability: 'stems', // the incumbent capability every existing worker already advertises
		liveSelectable: true,
		speed: 'fast',
		models: [
			{
				id: 'htdemucs',
				label: 'HT-Demucs',
				note: 'Fastest. The default — singable in seconds.',
				// 50s for a 171.5s song, measured end to end.
				cost: { rtFactor: 0.29, cpuPrecision: 'fp32', provenance: 'measured' },
			},
			{
				id: 'htdemucs_ft',
				label: 'HT-Demucs FT',
				note: 'Fine-tuned 4-model bag. ~2× slower, cleaner.',
				// 95s for the same 171.5s song, measured end to end.
				cost: { rtFactor: 0.55, cpuPrecision: 'fp32', provenance: 'measured' },
			},
			{
				id: 'htdemucs_6s',
				label: 'HT-Demucs 6-stem',
				note: 'Adds piano/guitar stems.',
				// NOT benchmarked: one pass like htdemucs but resolving six sources instead of four.
				cost: { rtFactor: 0.4, cpuPrecision: 'fp32', provenance: 'estimated' },
			},
		],
	},
	{
		id: 'roformer',
		label: 'BS-RoFormer',
		capability: 'stems:roformer', // a distinct capability — only a roformer-equipped worker takes it
		liveSelectable: true, // allowed live, but very slow on CPU — the UI warns
		speed: 'slow',
		models: [
			{
				id: 'bs-roformer-1297',
				label: 'BS-RoFormer',
				note: 'Highest separation quality. Minutes, not seconds — best as an upgrade.',
				/**
				 * 16.55s per 8s window at bf16 (fp32 was 26.59s), × overlap 4 ⇒ 8.28. bf16 rather than
				 * fp32 because it measured 1.6× faster here and truncates only the mantissa — bf16 keeps
				 * fp32's exponent range, so it is a near-lossless win rather than a quality tradeoff.
				 *
				 * `overlap` stays at this checkpoint's own default of 4. Halving it to 2 is a further
				 * measured 1.83× (rtFactor would fall to 4.14) but overlap-add is what suppresses audible
				 * seams at window boundaries, so that one is a quality decision awaiting a listening test,
				 * not a free win like the dtype.
				 */
				cost: { rtFactor: 8.28, overlap: 4, cpuPrecision: 'bf16', provenance: 'measured' },
			},
		],
	},
	{
		id: 'ensemble',
		label: 'MVSEP Ensemble',
		capability: 'stems:ensemble',
		liveSelectable: false, // UPGRADE-ONLY: runs several models, far too slow for the live path
		speed: 'slow',
		models: [
			{
				id: 'instrumental_clean',
				label: 'Instrumental (clean)',
				note: 'Two-model ensemble, minimal vocal bleed.',
				// NOT benchmarked, and no ensemble worker exists yet: two roformer-class passes plus a
				// blend, so at least twice a single roformer cook.
				cost: { rtFactor: 18, overlap: 4, cpuPrecision: 'bf16', provenance: 'estimated' },
			},
			{
				id: 'instrumental_full',
				label: 'Instrumental (full)',
				note: 'Maximum instrument preservation.',
				cost: { rtFactor: 18, overlap: 4, cpuPrecision: 'bf16', provenance: 'estimated' },
			},
		],
	},
] as const;

/** The live default a fresh room cooks with until someone changes the setting. */
export const DEFAULT_ENGINE: SeparatorEngineId = 'demucs';
export const DEFAULT_MODEL = 'htdemucs';

export function getEngine(id: string): SeparatorEngine | undefined {
	return SEPARATOR_ENGINES.find((e) => e.id === id);
}

/** Is this a real, whitelisted engine+model pairing? The server calls this before enqueueing so a
 *  malformed or spoofed setting is rejected rather than reaching a worker that would fail mid-cook. */
export function isValidSeparator(engineId: string, modelId: string): boolean {
	const engine = getEngine(engineId);
	return !!engine && engine.models.some((m) => m.id === modelId);
}

/** A pairing valid for the LIVE default (excludes upgrade-only engines like ensemble). */
export function isLiveSelectable(engineId: string, modelId: string): boolean {
	const engine = getEngine(engineId);
	return !!engine && engine.liveSelectable && engine.models.some((m) => m.id === modelId);
}

/**
 * Relative separation quality, low to high — the declared upgrade ladder. Mirrors the worker's
 * QUALITY_RANK. Keyed on engine+model because the checkpoint matters as much as the engine (an
 * htdemucs_ft cook beats plain htdemucs on the same engine).
 *
 * An unranked pairing scores 0 and can never win a comparison, which keeps an unknown or
 * de-whitelisted model from displacing a known-good artifact.
 *
 * The former `roformer:mel-roformer-inst-v2` rung (rank 30) is gone: its worker-side token resolved
 * to a registry slug that does not exist, and the engine backing `roformer` today implements only the
 * BS-RoFormer architecture, so no mel-band checkpoint could ever have run. It was an option the phone
 * offered and no worker could satisfy. A de-whitelisted model stored in settings falls back per-field
 * through `normalizeGlobalSettings`, so removing it degrades an affected room to the default rather
 * than breaking it.
 */
const QUALITY_RANK: Record<string, number> = {
	'demucs:htdemucs': 10,
	'demucs:htdemucs_6s': 15,
	'demucs:htdemucs_ft': 20,
	'roformer:bs-roformer-1297': 35,
	'ensemble:instrumental_full': 40,
	'ensemble:instrumental_clean': 45
};

export function qualityRank(engineId: string, modelId: string): number {
	return QUALITY_RANK[`${engineId}:${modelId}`] ?? 0;
}

/** The measured cost record for a pairing, or undefined if the pairing is not whitelisted. */
export function separatorCost(engineId: string, modelId: string): SeparatorCost | undefined {
	return getEngine(engineId)?.models.find((m) => m.id === modelId)?.cost;
}

/**
 * How long a cook of `songSeconds` is expected to take, in seconds — what the UI needs to say "about
 * four minutes" instead of a bare "slow".
 *
 * `hardwareFactor` scales the reference-box measurement for a different worker: >1 for a slower box,
 * <1 for a faster one (the Arc A380 deploy box is roughly 0.5 at fp32 and 0.25 at fp16 — see
 * `REFERENCE_BOX`). Returns null for an unranked pairing rather than guessing, so a caller renders
 * "unknown" instead of a fabricated number.
 */
export function estimateCookSeconds(
	engineId: string,
	modelId: string,
	songSeconds: number,
	hardwareFactor = 1
): number | null {
	const cost = separatorCost(engineId, modelId);
	if (!cost || !Number.isFinite(songSeconds) || songSeconds <= 0) return null;
	return Math.round(songSeconds * cost.rtFactor * hardwareFactor);
}

/**
 * Whether `candidate` is strictly better than `current` — the guard the upgrade path uses before it
 * swaps a published instrumental.
 *
 * A missing `current` counts as an upgrade (nothing to regress). Equal or lower rank does NOT, so a
 * re-cook at the same quality is a no-op and a worse engine can never replace a better artifact.
 */
export function isQualityUpgrade(
	current: { engine: string; model: string } | null | undefined,
	candidate: { engine: string; model: string }
): boolean {
	const cand = qualityRank(candidate.engine, candidate.model);
	if (cand === 0) return false;
	if (!current) return true;
	return cand > qualityRank(current.engine, current.model);
}

// ── settings scopes ─────────────────────────────────────────────────────────
// Two layers, split by WHO A SETTING BELONGS TO:
//
//   GLOBAL — a property of this deployment and its worker fleet. An engine is only usable if some
//     connected worker advertises its capability — a hardware fact, not a party's. Two rooms on one
//     core cannot meaningfully disagree about whether a RoFormer worker exists, so per-room copies
//     would model a distinction that isn't real.
//
//   ROOM — a property of one party. Pacing and per-room policy: two rooms genuinely can want
//     different interstitial timing, and a busy room may want to cap cook quality to keep its queue
//     moving while the deployment default stays high.
//
// Both are authoritative SERVER state broadcast to clients (like presence), never phone-local
// preferences two devices could disagree about.

/** Deployment-wide separator and cook policy. Owned by the operator. */
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

export function isTvProgressStyle(v: unknown): v is TvProgressStyle {
	return typeof v === 'string' && TV_PROGRESS_STYLES.some((s) => s.id === v);
}

/**
 * What the TV paints BEHIND the video.
 *
 * Worth knowing why this matters more than it sounds: a make-karaoke song plays a separated
 * instrumental, which has no video track, so the `<video>` renders nothing and this background is
 * the ENTIRE visual field for the song — sitting directly behind the word-timed lyric reel. It is
 * not decoration around letterbox bars.
 *
 * A registry rather than a bare union, for the same reason as TV_PROGRESS_STYLES: the phone renders
 * the picker from one source and a new style cannot be added without a label.
 *
 * ONE axis, not two. These do not compose — "one colour" and "the singer's colour" are two answers
 * to the same question, so a second axis would only manufacture invalid combinations.
 */
export const TV_BACKGROUND_STYLES = [
	{ id: 'off', label: 'Black', note: 'Plain black behind the song. What the TV has always done.' },
	{
		id: 'gradient',
		label: 'Room glow',
		note: 'The same glow the join and lobby screens use, kept up while a song plays.'
	},
	{
		id: 'singer',
		label: "Singer's colour",
		note: 'The stage takes the colour of whoever is up, and changes with each turn.'
	},
	{ id: 'solid', label: 'One colour', note: 'A single colour you pick below. Stays put all night.' },
	{
		id: 'visualizer',
		label: 'Audio visualizer',
		note: 'Moving light behind the words, like an old media player. Pick which one below.'
	}
] as const;

export type TvBackgroundStyle = (typeof TV_BACKGROUND_STYLES)[number]['id'];

export function isTvBackgroundStyle(v: unknown): v is TvBackgroundStyle {
	return typeof v === 'string' && TV_BACKGROUND_STYLES.some((s) => s.id === v);
}

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

export function isTvVisualizer(v: unknown): v is TvVisualizerId {
	return typeof v === 'string' && TV_VISUALIZERS.some((s) => s.id === v);
}

export interface RoomSettings {
	/** Which progress treatment the TV renders. */
	tvProgressStyle: TvProgressStyle;
	/** What the TV paints behind the song. Room-scoped: it is one party's staging taste. */
	tvBackgroundStyle: TvBackgroundStyle;
	/**
	 * Hue angle (0–359, quantised to SINGER_HUE_STEP) that colours the stage. Read by BOTH the `solid`
	 * background and the `visualizer` one — they need the same thing (one hue, rendered inside the
	 * legibility bound), so they share the field rather than each carrying their own.
	 *
	 * A HUE, not a hex, on purpose. The rendered colour is generated at the pinned stage lightness by
	 * `stageHueToHex`, so a room cannot pick something bright enough to wash out the lyric reel, and
	 * there is no colour string to parse — the `#rgb`-vs-`#rrggbb` trap that silently dropped the
	 * singer halo cannot recur here.
	 */
	tvBackgroundHue: number;
	/**
	 * Which visualizer runs when `tvBackgroundStyle === 'visualizer'`. Ignored otherwise.
	 *
	 * Held even while another background is selected, so switching to the visualizer and back does not
	 * forget the choice — the same reason `tvBackgroundHue` survives a switch away from `solid`.
	 */
	tvVisualizer: TvVisualizerId;
	/** TV "Next up" reveal duration. 0 = pure gapless hard-cut. Per-room because pacing is a property
	 *  of the party, not the deployment. */
	interstitialMs: number;
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
	 * How long a singer stays in the room after their last socket drops AND their last pending song
	 * leaves the queue. Per-room because it is a property of the party: a long evening where people
	 * pocket their phones wants a generous window, a kiosk wants none.
	 */
	presenceGraceMinutes: number;
}

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
	tvProgressStyle: 'card',
	// `off` so an existing box looks byte-identical after the migration: today's TV is plain black
	// behind the song, and a default that changed the stage would be a surprise, not a feature.
	tvBackgroundStyle: 'off',
	// 240° — the blue that tested cleanest against the pink active word. Only used once a room picks
	// `solid`, so this is the starting point of the slider rather than something anyone sees by default.
	tvBackgroundHue: 240,
	// Plasma is the one every old media player had, so it is the least surprising thing to find running
	// the first time a room turns the visualizer on.
	tvVisualizer: 'plasma',
	interstitialMs: 2500,
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
	presenceGraceMinutes: DEFAULT_PRESENCE_GRACE_MINUTES
};

/** Coerce a partial/untrusted object to valid RoomSettings, falling back per-field. */
export function normalizeRoomSettings(
	input: Partial<RoomSettings> | null | undefined,
	base: RoomSettings = DEFAULT_ROOM_SETTINGS
): RoomSettings {
	// Falls back to the CURRENT room values, not hardcoded defaults: rejecting one invalid field must
	// not discard an unrelated choice the room already made.
	const d = base;
	const ms = input?.interstitialMs;
	// Clamped rather than rejected: a nonsensical value should still yield a usable room, and an
	// unbounded interstitial would strand the TV between songs.
	const interstitialMs =
		typeof ms === 'number' && Number.isFinite(ms) ? Math.min(15_000, Math.max(0, Math.round(ms))) : d.interstitialMs;
	const cap = input?.maxQualityRank;
	const maxQualityRank = typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? Math.round(cap) : null;
	const style = input?.tvProgressStyle;
	const tvProgressStyle = isTvProgressStyle(style) ? style : d.tvProgressStyle;
	const ball = input?.lyricsBall;
	const lyricsBall = isValidLyricsBall(ball) ? ball : d.lyricsBall;
	const highlight = input?.lyricsHighlight;
	const lyricsHighlight = isValidLyricsHighlight(highlight) ? highlight : d.lyricsHighlight;
	// Clamped, like interstitialMs and for the same reason: a lead of 30s is nonsense but should still
	// leave a usable room. A NEGATIVE lead is clamped to 0 rather than honoured — running the highlight
	// BEHIND the audio has no use case and reads as the overlay being broken.
	const lead = input?.lyricsLeadMs;
	const lyricsLeadMs =
		typeof lead === 'number' && Number.isFinite(lead)
			? Math.min(MAX_LYRICS_LEAD_MS, Math.max(0, Math.round(lead)))
			: d.lyricsLeadMs;
	// One helper for the three bounded integers. Clamped rather than rejected, like interstitialMs: a
	// nonsensical value should still leave a usable room, and every bound here has a stated reason in
	// lyrics-engines.ts (a legibility floor, or a row count past which the type must shrink to fit).
	const clampInt = (v: unknown, lo: number, hi: number, fallback: number) =>
		typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
	const lyricsScalePct = clampInt(
		input?.lyricsScalePct,
		MIN_LYRICS_SCALE_PCT,
		MAX_LYRICS_SCALE_PCT,
		d.lyricsScalePct
	);
	// Zero is a legitimate value for both: a room may want no history, or nothing revealed ahead.
	const lyricsLinesBefore = clampInt(input?.lyricsLinesBefore, 0, MAX_LYRICS_LINES_BEFORE, d.lyricsLinesBefore);
	const lyricsLinesAfter = clampInt(input?.lyricsLinesAfter, 0, MAX_LYRICS_LINES_AFTER, d.lyricsLinesAfter);
	const font = input?.lyricsFont;
	const lyricsFont = isValidLyricsFont(font) ? font : d.lyricsFont;
	const textCase = input?.lyricsCase;
	const lyricsCase = isValidLyricsCase(textCase) ? textCase : d.lyricsCase;
	const bg = input?.tvBackgroundStyle;
	const tvBackgroundStyle = isTvBackgroundStyle(bg) ? bg : d.tvBackgroundStyle;
	// Quantised and wrapped rather than rejected, matching interstitialMs: a hue is an angle, so every
	// number has a valid meaning once wrapped, and snapping to the wheel's step keeps the phone slider
	// and the rendered stage agreeing. Non-finite input is the only thing with no sane reading.
	const rawHue = input?.tvBackgroundHue;
	const tvBackgroundHue =
		typeof rawHue === 'number' && Number.isFinite(rawHue)
			? (((Math.round(rawHue / SINGER_HUE_STEP) * SINGER_HUE_STEP) % 360) + 360) % 360
			: d.tvBackgroundHue;
	// Clamped, like interstitialMs: a room default outside 0..1 should still yield a usable room. Note
	// this one is NOT nullable — the room default is the floor the per-song override falls back to, so
	// there is nothing below it to inherit from. A junk write keeps the room's current value.
	// Clamped like interstitialMs: a nonsensical window should still yield a usable room. 0 is a real
	// choice (no grace once your songs are done), so it is a bound rather than a rejected value.
	const grace = input?.presenceGraceMinutes;
	const presenceGraceMinutes =
		typeof grace === 'number' && Number.isFinite(grace)
			? Math.min(MAX_PRESENCE_GRACE_MINUTES, Math.max(MIN_PRESENCE_GRACE_MINUTES, Math.round(grace)))
			: d.presenceGraceMinutes;
	const gl = input?.guideLevelDefault;
	const guideLevelDefault =
		typeof gl === 'number' && Number.isFinite(gl)
			? Math.round(Math.min(1, Math.max(0, gl)) * 100) / 100
			: d.guideLevelDefault;
	const viz = input?.tvVisualizer;
	const tvVisualizer = isTvVisualizer(viz) ? viz : d.tvVisualizer;
	return {
		tvProgressStyle,
		tvBackgroundStyle,
		tvBackgroundHue,
		tvVisualizer,
		interstitialMs,
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
	 * True when the room asked for something the global sync mode cannot produce, so what is returned
	 * is a degraded substitute. The Settings page says so rather than showing a picker whose value is
	 * silently ignored — a control that does nothing is worse than one that is absent.
	 */
	clamped: boolean;
}

/**
 * Resolve the room's lyrics presentation against what the deployment actually produces.
 *
 * The clamp is DOWNWARD-ONLY, the same shape as `resolveCookSeparator`'s quality ceiling and for the
 * same kind of reason: the global setting is bounded by what the worker fleet can do, so a room must
 * not be able to request something no cook produced. Here the bound is timing granularity — under
 * `syncMode: 'lines'` there are no per-word timestamps, so a word-level highlight has nothing to
 * light and a marker has no word to sit on.
 *
 * Deliberately reads `needsWords`/`granularity` off the registries instead of testing style ids, so
 * adding a style is a registry entry and not an edit here.
 */
export function resolveLyricsPresentation(settings: EffectiveSettings): LyricsPresentation {
	const { lyricsBall, lyricsHighlight, lyricsLeadMs } = settings.room;
	const leadSec = lyricsLeadMs / 1000;
	const wordsAvailable = getSyncMode(settings.global.syncMode)?.granularity === 'word';
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
