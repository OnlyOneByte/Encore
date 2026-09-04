// The two knobs on the LYRICS half of a cook: which model reads the words, and how those words get
// timestamps. The third and fourth axes alongside separator engine/model and fetcher.
//
// WHY THIS EXISTS. Both were hardcoded on the worker with no way to change them from the deployment.
// `DEFAULT_MODEL = "base"` in whisperx.py was the ASR model for every box forever, and dial_home.py
// never passed a model at all, so even an env var would not have reached it. Timing had no knob:
// forced alignment was the only path, with line sync reachable ONLY as a failure fallback inside an
// `except`. So an operator who could see the words were wrong on the TV had nothing to turn.
//
// These are GLOBAL, not room-scoped, for the same reason the separator and fetcher are: they are
// properties of the box and its worker fleet — model weights that have to be downloaded and RAM that
// has to hold them. Two parties on one core cannot want different Whisper models any more than they
// can want different downloaders.
//
// Mirrors separators.ts and fetchers.ts deliberately: a registry rather than a bare union, so a
// stored setting can be validated against it, the settings page renders a picker from one source,
// and a new model cannot be added without a label and a stated tradeoff.

/**
 * A faster-whisper model token, passed straight to `whisperx.load_model()`.
 *
 * The canonical five sizes only. Deliberately NOT included: the `.en` English-only variants (a
 * karaoke box gets handed songs in any language, and the ASR tier detects rather than assumes) and
 * the `distil-*` checkpoints (worth measuring, but an unverified token here becomes a cook that fails
 * at model load, which is exactly the failure mode the separator whitelist exists to prevent).
 */
export type AsrModelId = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';

export interface AsrModel {
	id: AsrModelId;
	label: string;
	/**
	 * Parameter count as published by OpenAI. A FACT about the checkpoint, and the honest thing to
	 * expose: it is the only cost signal available without measuring, and it is what the download and
	 * the resident memory scale with.
	 *
	 * It is NOT a measured cook cost on any box — contrast `SeparatorCost` in separators.ts, which
	 * carries a real rtFactor plus the box and date it was measured on. Do not add an rtFactor here
	 * until someone has actually timed these on the target hardware.
	 */
	params: string;
	/** Coarse relative cost, for a picker that has to say something before anything is measured. */
	speed: 'fastest' | 'fast' | 'moderate' | 'slow' | 'slowest';
	note: string;
}

export const ASR_MODELS: readonly AsrModel[] = [
	{
		id: 'tiny',
		label: 'Tiny',
		params: '39M',
		speed: 'fastest',
		note: 'Fastest and least accurate. Usable for a smoke test of the pipeline, not for words on a TV.'
	},
	{
		id: 'base',
		label: 'Base',
		params: '74M',
		speed: 'fast',
		note: 'The long-standing default. Measurably at its limit on sung vocals — it produced "It\'s no better to be saying it\'s ugly" for "safe than sorry".'
	},
	{
		id: 'small',
		label: 'Small',
		params: '244M',
		speed: 'moderate',
		note: 'The first size worth trusting with sung words. ~3x base\'s weights for a modest slice of the cook.'
	},
	{
		id: 'medium',
		label: 'Medium',
		params: '769M',
		speed: 'slow',
		note: 'Noticeably better on sung and accented vocals. Wants real RAM and adds real minutes on a CPU box.'
	},
	{
		id: 'large-v3',
		label: 'Large v3',
		params: '1550M',
		speed: 'slowest',
		note: 'Best available text. Only sane with a GPU, or on a box that cooks ahead of the party rather than during it.'
	}
];

/** Matches whisperx.py's DEFAULT_MODEL, so exposing this setting changes no existing behaviour. */
export const DEFAULT_ASR_MODEL: AsrModelId = 'base';

export function getAsrModel(id: string): AsrModel | undefined {
	return ASR_MODELS.find((m) => m.id === id);
}

export function isValidAsrModel(id: string): id is AsrModelId {
	return getAsrModel(id) !== undefined;
}

/**
 * How a song's words get their timestamps.
 *
 * Both modes are code paths that already existed — this setting only makes the second one REACHABLE
 * on purpose instead of solely as the landing spot of an `except` in whisperx.py's `_time_one`.
 */
export type SyncModeId = 'forced' | 'lines';

export interface SyncMode {
	id: SyncModeId;
	label: string;
	/** What the TV can actually do with the result — the difference an operator is choosing between. */
	granularity: 'word' | 'line';
	/** Whether this mode loads and runs the wav2vec2 align model. The cost, in one boolean. */
	usesAligner: boolean;
	note: string;
}

export const SYNC_MODES: readonly SyncMode[] = [
	{
		id: 'forced',
		label: 'Forced alignment (word timings)',
		granularity: 'word',
		usesAligner: true,
		note: 'wav2vec2 aligns the known text against the isolated vocals stem. Per-word highlighting and the bouncing ball. Falls back to line sync by itself if alignment fails.'
	},
	{
		id: 'lines',
		label: 'Line sync only',
		granularity: 'line',
		usesAligner: false,
		note: 'Skip alignment and use each source\'s own line timings. No second ML pass, so a cook finishes sooner — but the ball cannot follow individual words. Only as good as the source: an LRC from a different upload of the song is timed for that recording, not this one.'
	}
];

export const DEFAULT_SYNC_MODE: SyncModeId = 'forced';

export function getSyncMode(id: string): SyncMode | undefined {
	return SYNC_MODES.find((m) => m.id === id);
}

export function isValidSyncMode(id: string): id is SyncModeId {
	return getSyncMode(id) !== undefined;
}
