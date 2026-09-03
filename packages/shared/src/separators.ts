// @encore/shared — the pluggable stem-separator registry. SINGLE SOURCE OF TRUTH for both
// the SERVER (which validates an engine+model pairing before it enqueues a cook) and the PHONE UI
// (which renders the engine dropdown → model dropdown). The worker has its own SeparatorEngine
// registry that actually RUNS each engine; this module is only the contract — the ids, the
// whitelist, and the rules — so the three sides cannot drift.
//
// TWO AXES, kept deliberately separate (this is the whole design):
//   • ENGINE  — a distinct inference implementation. Adding one is real code AND a worker
//               `capability` the job is routed by (capabilities.includes(jobType)). Rare.
//   • MODEL   — a checkpoint WITHIN an engine, addressed by a stable token here and resolved to a
//               concrete checkpoint by the worker engine. Adding one is a whitelist edit, no code.
//
// Whitelisted on purpose (Angelo, 2026-09-03): the phone can only pick a model from this fixed set,
// so a phone tap can never trigger an arbitrary multi-hundred-MB checkpoint download onto the shared
// box. Widening to arbitrary Hugging Face ids is a deliberate future toggle, not the default.

export type SeparatorEngineId = 'demucs' | 'roformer' | 'ensemble';

export interface SeparatorModel {
	/** Stable token stored in JobParams.model and in room settings. NEVER a raw checkpoint filename —
	 *  the worker engine maps this token to a concrete checkpoint, so the checkpoint can be re-hosted
	 *  or renamed upstream without touching stored jobs or settings. */
	id: string;
	/** Human label for the phone dropdown. */
	label: string;
	/** One-line "why pick this" shown under the label. */
	note: string;
}

export interface SeparatorEngine {
	id: SeparatorEngineId;
	label: string;
	/** The worker CAPABILITY a worker must advertise to run this engine. Dispatch routes a stems job
	 *  to a worker via capabilities.includes(capability). A `demucs`-only worker never receives a
	 *  `roformer` cook, so engines can live on different boxes or (later) different images. */
	capability: string;
	/** Whitelisted, ordered best-effort by quality. First entry is the engine's default model. */
	models: SeparatorModel[];
	/** Upgrade-tier engines are heavy/slow and MUST NOT be selectable as the live default — they are
	 *  only valid as the target of a `stems-upgrade`. `ensemble` runs N models, so it is upgrade-only. */
	liveSelectable: boolean;
	/** Rough guidance for the UI, not a hard gate. */
	speed: 'fast' | 'medium' | 'slow';
}

// ── the registry ────────────────────────────────────────────────────────────────
// Measured on a 2:51 CPU cook (32-core box): htdemucs 50s, htdemucs_ft 95s, BS-RoFormer ~2629s.

export const SEPARATOR_ENGINES: readonly SeparatorEngine[] = [
	{
		id: 'demucs',
		label: 'Demucs',
		capability: 'stems', // the incumbent capability every existing worker already advertises
		liveSelectable: true,
		speed: 'fast',
		models: [
			{ id: 'htdemucs', label: 'HT-Demucs', note: 'Fastest. The default — singable in seconds.' },
			{ id: 'htdemucs_ft', label: 'HT-Demucs FT', note: 'Fine-tuned 4-model bag. ~2× slower, cleaner.' },
			{ id: 'htdemucs_6s', label: 'HT-Demucs 6-stem', note: 'Adds piano/guitar stems.' },
		],
	},
	{
		id: 'roformer',
		label: 'BS-RoFormer',
		capability: 'stems:roformer', // a distinct capability — only a roformer-equipped worker takes it
		liveSelectable: true, // allowed live, but very slow on CPU — the UI warns
		speed: 'slow',
		models: [
			{ id: 'bs-roformer-1297', label: 'BS-RoFormer 1297', note: 'Highest separation quality. Slow on CPU.' },
			{ id: 'mel-roformer-inst-v2', label: 'MelBand RoFormer Inst v2', note: 'Instrumental-tuned.' },
		],
	},
	{
		id: 'ensemble',
		label: 'MVSEP Ensemble',
		capability: 'stems:ensemble',
		liveSelectable: false, // UPGRADE-ONLY: runs several models, far too slow for the live path
		speed: 'slow',
		models: [
			{ id: 'instrumental_clean', label: 'Instrumental (clean)', note: 'Two-model ensemble, minimal vocal bleed.' },
			{ id: 'instrumental_full', label: 'Instrumental (full)', note: 'Maximum instrument preservation.' },
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
 * QUALITY_RANK. Keyed on engine+model because the checkpoint matters as much as the engine: an
 * htdemucs_ft cook beats a plain htdemucs one on the same engine.
 *
 * An unranked pairing scores 0 and therefore can never win a comparison, which is what keeps an
 * unknown or de-whitelisted model from displacing a known-good artifact.
 */
const QUALITY_RANK: Record<string, number> = {
	'demucs:htdemucs': 10,
	'demucs:htdemucs_6s': 15,
	'demucs:htdemucs_ft': 20,
	'roformer:mel-roformer-inst-v2': 30,
	'roformer:bs-roformer-1297': 35,
	'ensemble:instrumental_full': 40,
	'ensemble:instrumental_clean': 45
};

export function qualityRank(engineId: string, modelId: string): number {
	return QUALITY_RANK[`${engineId}:${modelId}`] ?? 0;
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
//     connected worker advertises its capability, which is a fact about the server's hardware, not
//     about a party. Two rooms on one core cannot meaningfully disagree about whether a RoFormer
//     worker exists, so duplicating these per room would be modelling a distinction that isn't real.
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
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
	defaultEngine: DEFAULT_ENGINE,
	defaultModel: DEFAULT_MODEL,
	enqueueUpgrade: false,
	upgradeEngine: 'roformer',
	upgradeModel: 'bs-roformer-1297'
};

/** Coerce a partial/untrusted object to valid GlobalSettings, falling back per-field. Used by the
 *  write API so a bad client payload degrades to defaults rather than persisting garbage. */
export function normalizeGlobalSettings(input: Partial<GlobalSettings> | null | undefined): GlobalSettings {
	const d = DEFAULT_GLOBAL_SETTINGS;
	const live =
		input && isLiveSelectable(input.defaultEngine ?? '', input.defaultModel ?? '')
			? { defaultEngine: input.defaultEngine!, defaultModel: input.defaultModel! }
			: { defaultEngine: d.defaultEngine, defaultModel: d.defaultModel };
	const upgrade =
		input && isValidSeparator(input.upgradeEngine ?? '', input.upgradeModel ?? '')
			? { upgradeEngine: input.upgradeEngine!, upgradeModel: input.upgradeModel! }
			: { upgradeEngine: d.upgradeEngine, upgradeModel: d.upgradeModel };
	return {
		...live,
		...upgrade,
		enqueueUpgrade: typeof input?.enqueueUpgrade === 'boolean' ? input.enqueueUpgrade : d.enqueueUpgrade,
	};
}

// ── room layer ──────────────────────────────────────────────────────────────
// One party's own policy. Kept deliberately small: a setting belongs here only when two rooms on one
// core could genuinely want different values.

export interface RoomSettings {
	/** TV "Next up" reveal duration. 0 = pure gapless hard-cut. Per-room because pacing is a property
	 *  of the party, not the deployment. */
	interstitialMs: number;
	/**
	 * Optional per-room ceiling on cook quality, as a `qualityRank`. A busy room can cap cooks to keep
	 * its queue moving while the deployment default stays high. `null` means "no ceiling — use the
	 * global default". A ceiling can only ever LOWER quality, never raise it above the global choice:
	 * the global setting is bounded by what the worker fleet can actually run, so a room must not be
	 * able to request an engine no worker advertises.
	 */
	maxQualityRank: number | null;
}

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
	interstitialMs: 2500,
	maxQualityRank: null
};

/** Coerce a partial/untrusted object to valid RoomSettings, falling back per-field. */
export function normalizeRoomSettings(input: Partial<RoomSettings> | null | undefined): RoomSettings {
	const d = DEFAULT_ROOM_SETTINGS;
	const ms = input?.interstitialMs;
	// Clamped rather than rejected: a nonsensical value should still yield a usable room, and an
	// unbounded interstitial would strand the TV between songs.
	const interstitialMs =
		typeof ms === 'number' && Number.isFinite(ms) ? Math.min(15_000, Math.max(0, Math.round(ms))) : d.interstitialMs;
	const cap = input?.maxQualityRank;
	const maxQualityRank = typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? Math.round(cap) : null;
	return { interstitialMs, maxQualityRank };
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
 * The engine+model a cook in this room should actually use.
 *
 * The global default wins unless the room set a lower ceiling, in which case the best
 * live-selectable pairing at or under that ceiling is chosen. A room can only ever cap quality
 * DOWNWARD: raising it could name an engine no connected worker advertises, and the job would sit
 * queued forever.
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
