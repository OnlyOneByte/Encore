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

export type SeparatorEngineId = 'demucs' | 'roformer' | 'ensemble';

/**
 * What a checkpoint COSTS to run, measured rather than guessed.
 *
 * Every field here was benchmarked on the reference box (32-core Graviton 3, CPU, aarch64) on
 * 2026-09-03. Three results drove the shape of this type:
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
	 * other hardware before treating it as absolute — it is a measurement on one box, not a constant.
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
	/**
	 * Relative separation quality, low to high — this model's rung on the upgrade ladder. Lives on the
	 * model beside `cost` so the registry is the single source of truth: a new whitelisted model cannot
	 * typecheck without one, which is what makes the "silently ranks 0 and drops off the cook ladder"
	 * failure structurally impossible rather than a thing a separate table has to remember. Compared
	 * ACROSS engines (an htdemucs_ft cook beats plain htdemucs; a roformer cook beats both), so the
	 * numbers are globally ordered, not per-engine. Positive by construction here; `qualityRank`
	 * returns 0 only for a pairing that is not in the registry at all (unknown or de-whitelisted),
	 * which is what keeps such a pairing from ever displacing a known-good artifact.
	 */
	rank: number;
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
				// 50s for a 171.5s song, measured end to end.
				cost: { rtFactor: 0.29, cpuPrecision: 'fp32', provenance: 'measured' }
			},
			{
				id: 'htdemucs_ft',
				label: 'HT-Demucs FT',
				note: 'Fine-tuned 4-model bag. ~2× slower, cleaner.',
				rank: 20,
				// 95s for the same 171.5s song, measured end to end.
				cost: { rtFactor: 0.55, cpuPrecision: 'fp32', provenance: 'measured' }
			},
			{
				id: 'htdemucs_6s',
				label: 'HT-Demucs 6-stem',
				note: 'Adds piano/guitar stems.',
				rank: 15,
				// NOT benchmarked: one pass like htdemucs but resolving six sources instead of four.
				cost: { rtFactor: 0.4, cpuPrecision: 'fp32', provenance: 'estimated' }
			}
		]
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
				rank: 35,
				cost: { rtFactor: 8.28, overlap: 4, cpuPrecision: 'bf16', provenance: 'measured' }
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
				// NOT benchmarked, and no ensemble worker exists yet: two roformer-class passes plus a
				// blend, so at least twice a single roformer cook.
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
 * Relative separation quality, low to high — the declared upgrade ladder, read straight off the
 * registry (`SeparatorModel.rank`). The checkpoint matters as much as the engine (an htdemucs_ft cook
 * beats plain htdemucs on the same engine), and ranks are globally ordered across engines.
 *
 * Returns 0 for a pairing that is not in the registry — an unknown or de-whitelisted model — and a
 * rank-0 pairing can never win a comparison, which keeps such a model from displacing a known-good
 * artifact. Crucially it can no longer return 0 for a *whitelisted* model: `rank` is a required field
 * on `SeparatorModel`, so a new whitelist entry cannot compile without one. The former hand-maintained
 * `QUALITY_RANK` parallel table is gone precisely because it let a whitelisted model silently rank 0
 * and drop off the cook ladder.
 *
 * The former `roformer:mel-roformer-inst-v2` rung (rank 30) is likewise gone: its worker-side token
 * resolved to a registry slug that does not exist, and the engine backing `roformer` today implements
 * only the BS-RoFormer architecture, so no mel-band checkpoint could ever have run. A de-whitelisted
 * model stored in settings falls back per-field through `normalizeGlobalSettings`, so removing it
 * degrades an affected room to the default rather than breaking it.
 */
export function qualityRank(engineId: string, modelId: string): number {
	return getEngine(engineId)?.models.find((m) => m.id === modelId)?.rank ?? 0;
}

/** The measured cost record for a pairing, or undefined if the pairing is not whitelisted. */
export function separatorCost(engineId: string, modelId: string): SeparatorCost | undefined {
	return getEngine(engineId)?.models.find((m) => m.id === modelId)?.cost;
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
