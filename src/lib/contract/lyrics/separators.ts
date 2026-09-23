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
		label: 'Mel-Band RoFormer',
		capability: 'stems:audiosep',
		liveSelectable: true,
		speed: 'medium',
		models: [
			{
				id: 'instrumental_becruily',
				label: 'Mel-Band Instrumental (becruily)',
				note: 'RoFormer-quality instrumental, ~10× faster than BS-RoFormer on CPU.',
				// fp32 and NOT bf16: bf16 measured a LOSS on this architecture — the sign reversal that makes
				// `cpuPrecision` per-model. LICENCE CAVEAT: these weights may carry non-commercial terms; the
				// project's clearance covers packages, never checkpoint weights.
				rank: 30,
				cost: { rtFactor: 1.28, overlap: 2, cpuPrecision: 'fp32', provenance: 'measured' }
			}
		]
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
				rank: 45,
				// Estimated: two roformer-class passes plus a blend, and no ensemble worker exists yet.
				cost: { rtFactor: 18, overlap: 4, cpuPrecision: 'bf16', provenance: 'estimated' }
			},
			{
				id: 'instrumental_full',
				label: 'Instrumental (full)',
				note: 'Maximum instrument preservation.',
				rank: 40,
				cost: { rtFactor: 18, overlap: 4, cpuPrecision: 'bf16', provenance: 'estimated' }
			}
		]
	}
] as const;

/** The live default a fresh room processes with until someone changes the setting. */
export const DEFAULT_ENGINE: SeparatorEngineId = 'demucs';
export const DEFAULT_MODEL = 'htdemucs';

export function getEngine(id: string): SeparatorEngine | undefined {
	return SEPARATOR_ENGINES.find((e) => e.id === id);
}

/** Is this a real, whitelisted engine+model pairing? Called before enqueueing, so a spoofed setting never
 *  reaches a worker that would fail mid-process. */
export function isValidSeparator(engineId: string, modelId: string): boolean {
	const engine = getEngine(engineId);
	return !!engine && engine.models.some((m) => m.id === modelId);
}

/** A pairing valid for the LIVE default (excludes upgrade-only engines like ensemble). */
export function isLiveSelectable(engineId: string, modelId: string): boolean {
	const engine = getEngine(engineId);
	return !!engine && engine.liveSelectable && engine.models.some((m) => m.id === modelId);
}

/** The declared upgrade ladder, read straight off `SeparatorModel.rank`. Returns 0 ONLY for a pairing absent
 *  from the registry, which is what makes de-whitelisting safe. See
 *  docs/SERVER.md#registries-and-the-quality-ladder. */
export function qualityRank(engineId: string, modelId: string): number {
	return getEngine(engineId)?.models.find((m) => m.id === modelId)?.rank ?? 0;
}

/** The measured cost record for a pairing, or undefined if the pairing is not whitelisted. */
export function separatorCost(engineId: string, modelId: string): SeparatorCost | undefined {
	return getEngine(engineId)?.models.find((m) => m.id === modelId)?.cost;
}

/** Is `candidate` STRICTLY better than `current`? The guard the upgrade path runs before swapping a published
 *  instrumental. See docs/SERVER.md#registries-and-the-quality-ladder. */
export function isQualityUpgrade(
	current: { engine: string; model: string } | null | undefined,
	candidate: { engine: string; model: string }
): boolean {
	const cand = qualityRank(candidate.engine, candidate.model);
	if (cand === 0) return false;
	if (!current) return true;
	return cand > qualityRank(current.engine, current.model);
}
