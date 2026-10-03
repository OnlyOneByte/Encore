// The stem-separator registry: the SINGLE SOURCE OF TRUTH for the server's validation and the phone's pickers.
// The worker keeps its own registry that RUNS each engine; this is only ids, whitelist and rules.
// Rules: docs/SERVER.md#registries-and-the-quality-ladder. Axes: docs/ARCHITECTURE.md §7.

export type SeparatorEngineId = 'demucs' | 'roformer' | 'audiosep' | 'ensemble';

/** What a checkpoint COSTS to run, measured rather than guessed. Two traps shape this type: `cpuPrecision`
 *  REVERSES per checkpoint, and parameter count does NOT predict cost. See
 *  docs/SERVER.md#registries-and-the-quality-ladder. */
export interface SeparatorCost {
	/** MEASURED wall-clock seconds per second of song. A RATIO for UI estimation and NEVER a gate — it is one
	 *  box's measurement. */
	rtFactor: number;
	/** Overlapping prediction windows as an INTEGER COUNT, deliberately ABSENT where an engine's overlap is a
	 *  fraction instead — one field name for two meanings is how a `4` gets passed where `0.25` belongs. */
	overlap?: number;
	/** Precision for this checkpoint ON A CPU BOX — a (checkpoint × hardware) fact, not a property of the
	 *  checkpoint. A GPU backend overrides it. */
	cpuPrecision: 'fp32' | 'bf16';
	/** Whether the numbers were benchmarked or reasoned about. An `estimated` cost is honest guidance for
	 *  the UI but must NEVER be cited as evidence. */
	provenance: 'measured' | 'estimated';
}

export interface SeparatorModel {
	/** Stable TOKEN stored in `JobParams.model` and room settings, NEVER a checkpoint filename, so upstream can
	 *  re-host or rename without touching stored jobs. */
	id: string;
	/** Human label for the phone dropdown. */
	label: string;
	/** One-line "why pick this" shown under the label. */
	note: string;
	/** Measured cost of running this checkpoint. See `SeparatorCost`. */
	cost: SeparatorCost;
	/** This model's rung on the upgrade ladder, GLOBALLY ordered across engines. REQUIRED and on the model
	 *  rather than in a parallel table. See docs/SERVER.md#registries-and-the-quality-ladder. */
	rank: number;
}

export interface SeparatorEngine {
	id: SeparatorEngineId;
	label: string;
	/** The capability a worker must ADVERTISE to run this engine; dispatch routes by it, so engines can live on
	 *  different boxes. */
	capability: string;
	/** Whitelisted, ordered best-effort by quality. FIRST entry is the engine's default model. */
	models: SeparatorModel[];
	/** False means UPGRADE-ONLY: never selectable as the live default. */
	liveSelectable: boolean;
	/** Rough guidance for the UI, not a hard gate. */
	speed: 'fast' | 'medium' | 'slow';
}

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
				rank: 10,
				cost: { rtFactor: 0.29, cpuPrecision: 'fp32', provenance: 'measured' }
			},
			{
				id: 'htdemucs_ft',
				label: 'HT-Demucs FT',
				note: 'Fine-tuned 4-model bag. ~2× slower, cleaner.',
				rank: 20,
				cost: { rtFactor: 0.55, cpuPrecision: 'fp32', provenance: 'measured' }
			},
			{
				id: 'htdemucs_6s',
				label: 'HT-Demucs 6-stem',
				note: 'Adds piano/guitar stems.',
				rank: 15,
				cost: { rtFactor: 0.4, cpuPrecision: 'fp32', provenance: 'estimated' }
			}
		]
	},
	{
		id: 'roformer',
		label: 'BS-RoFormer',
		capability: 'stems:roformer',
		liveSelectable: true, // slow on CPU, so the UI warns
		speed: 'slow',
		models: [
			{
				id: 'bs-roformer-1297',
				label: 'BS-RoFormer',
				note: 'Highest separation quality. Minutes, not seconds — best as an upgrade.',
				// bf16 is near-lossless here and measured faster. Lowering `overlap` is a further measured
				// speed-up but a QUALITY decision: overlap-add is what suppresses audible seams.
				rank: 35,
				cost: { rtFactor: 8.28, overlap: 4, cpuPrecision: 'bf16', provenance: 'measured' }
			}
		]
	},
	{
		id: 'audiosep',
		label: 'Model zoo',
		capability: 'stems:audiosep',
		liveSelectable: true,
		speed: 'medium',
		/*
		 * EMPTY ON PURPOSE — this engine's models are REPORTED BY THE WORKERS, not listed here.
		 *
		 * It used to carry one hardcoded entry, `instrumental_becruily`, with a cost labelled
		 * `provenance: 'measured'`. No worker could run it: there was no audiosep adapter at all, so choosing
		 * it queued a job that no capability matched and nothing on screen explained why. The worker now
		 * enumerates ~135 checkpoints from the library it actually has installed and sends them in
		 * `worker:catalogue`; the settings page appends those to this engine's list.
		 *
		 * Keep it empty. A name typed here is a claim about a remote box that this file cannot check, which is
		 * exactly the failure the frame replaced.
		 */
		models: []
	}
] as const;

/*
 * THE `ensemble` ENGINE WAS REMOVED HERE, and it is not coming back as a constant.
 *
 * It advertised `instrumental_clean` and `instrumental_full` at `rtFactor: 18, provenance: 'estimated'`,
 * behind `capability: 'stems:ensemble'` — which no worker has ever advertised, because no ensemble adapter
 * exists. Both were upgrade-only, so the failure was quiet: an operator set an upgrade model, upgrades
 * silently never ran, and `hasCapableWorker` was false forever.
 *
 * If an ensemble runtime is built, it arrives the same way every other model now does: the worker announces
 * it. `qualityRank`/`isQualityUpgrade` consult this constant, so a re-added phantom would also re-enter the
 * upgrade-ranking maths with an invented number.
 */

/** The live default a fresh room processes with until someone changes the setting. */
export const DEFAULT_ENGINE: SeparatorEngineId = 'demucs';
export const DEFAULT_MODEL = 'htdemucs';

export function getEngine(id: string): SeparatorEngine | undefined {
	return SEPARATOR_ENGINES.find((e) => e.id === id);
}

/** A model is only ever resolved WITHIN its engine — a token is not unique across the registry — so the
 *  two-step traversal is written once and every question below asks it the same way. */
function findModel(engineId: string, modelId: string): SeparatorModel | undefined {
	return getEngine(engineId)?.models.find((m) => m.id === modelId);
}

/**
 * The engine whose models are reported by the workers rather than listed here.
 *
 * Its validity cannot be decided in this file: which checkpoints exist is a property of the
 * `audio-separator` version a worker has installed, and this module runs in the browser.
 */
const WORKER_POPULATED_ENGINE = 'audiosep';

/**
 * A token shaped like one a worker announces. Slug-cased, which is what `zoo.slugify` emits.
 *
 * DELIBERATELY A SHAPE CHECK AND NOT A MEMBERSHIP ONE, because there is no list to check against here. The
 * consequence of a token no worker has is already handled and VISIBLE: `requiredCapability` narrows the job
 * to `stems:model:<token>`, no worker matches, `hasCapableWorker` is false, and core reports the media as
 * `unservable` — the same path as asking for an engine nobody runs. That is a better failure than the
 * alternative, which is what this replaced: `isValidSeparator` consulted the static list, so every
 * worker-reported token was silently discarded and the setting snapped back to the default.
 */
function looksLikeWorkerToken(modelId: string): boolean {
	return /^[a-z0-9]+(-[a-z0-9]+)+$/.test(modelId);
}

/** Is this a real, whitelisted engine+model pairing? Called before enqueueing, so a spoofed setting never
 *  reaches a worker that would fail mid-process. */
export function isValidSeparator(engineId: string, modelId: string): boolean {
	if (findModel(engineId, modelId)) return true;
	// The zoo's models live on the workers; see `looksLikeWorkerToken` for why a shape check is the right
	// gate and what the failure mode is when the token names nothing.
	return engineId === WORKER_POPULATED_ENGINE && looksLikeWorkerToken(modelId);
}

/** A pairing valid for the LIVE default (excludes any engine marked upgrade-only). */
export function isLiveSelectable(engineId: string, modelId: string): boolean {
	return getEngine(engineId)?.liveSelectable === true && isValidSeparator(engineId, modelId);
}

/** The declared upgrade ladder, read straight off `SeparatorModel.rank`. Returns 0 ONLY for a pairing absent
 *  from the registry, which is what makes de-whitelisting safe. See
 *  docs/SERVER.md#registries-and-the-quality-ladder. */
export function qualityRank(engineId: string, modelId: string): number {
	return findModel(engineId, modelId)?.rank ?? 0;
}

/** The measured cost record for a pairing, or undefined if the pairing is not whitelisted. */
export function separatorCost(engineId: string, modelId: string): SeparatorCost | undefined {
	return findModel(engineId, modelId)?.cost;
}

/** Is `candidate` STRICTLY better than `current`? The guard the upgrade path runs before swapping a published
 *  instrumental. See docs/SERVER.md#registries-and-the-quality-ladder. */
export function isQualityUpgrade(
	current: { engine: string; model: string } | null | undefined,
	candidate: { engine: string; model: string }
): boolean {
	// A WORKER-REPORTED MODEL HAS NO RANK IN THIS FILE, and treating that as rank 0 was a silent refusal:
	// the upgrade job would run to completion — minutes of separation — and then be rejected at the swap,
	// because `cand === 0` returns false below. Nothing downstream would say why.
	//
	// An operator who picks a specific zoo checkpoint as their upgrade target has stated an intent this
	// registry cannot rank against, so the intent is honoured. The ladder still governs everything it
	// actually knows about, which is every built-in pairing.
	if (isWorkerReportedModel(candidate.engine, candidate.model)) return true;
	const cand = qualityRank(candidate.engine, candidate.model);
	if (cand === 0) return false;
	if (!current) return true;
	return cand > qualityRank(current.engine, current.model);
}

/** A pairing this file knows is valid but cannot rank, because the worker supplied it. */
export function isWorkerReportedModel(engineId: string, modelId: string): boolean {
	return engineId === WORKER_POPULATED_ENGINE && !findModel(engineId, modelId) && looksLikeWorkerToken(modelId);
}
