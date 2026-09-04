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

// ── presentation ────────────────────────────────────────────────────────────
// The two knobs above are PRODUCTION: they decide what timing data a cook produces, and they are
// global because they cost model weights and RAM. The two below are PRESENTATION: they decide how
// data that already exists gets drawn on one room's TV, and they are room-scoped for the same reason
// `tvProgressStyle` is — a staging choice for one party's screen.
//
// They live here rather than beside `tvProgressStyle` in separators.ts because they are COUPLED to
// `SYNC_MODES` above: a room can only render at or below the granularity the global mode produced.
// Keeping the registry and the constraint it is checked against in one file is what stops the two
// drifting. The resolver that applies the clamp is `resolveLyricsPresentation` in separators.ts,
// which is where `EffectiveSettings` lives.

/**
 * The mark that tracks the word being sung.
 *
 * `needsWords` is the load-bearing field, not documentation: every marker except `off` has to sit on
 * a specific word, so under `syncMode: 'lines'` there is no word to sit on and the mark is not merely
 * ugly but unrenderable. The resolver reads this rather than re-deriving the rule per style.
 */
export type LyricsBallStyleId = 'bounce' | 'steady' | 'underline' | 'off';

export interface LyricsBallStyle {
	id: LyricsBallStyleId;
	label: string;
	/** Whether this mark requires per-word timings to have somewhere to land. */
	needsWords: boolean;
	note: string;
}

export const LYRICS_BALL_STYLES: readonly LyricsBallStyle[] = [
	{
		id: 'bounce',
		label: 'Bouncing ball',
		needsWords: true,
		note: 'A dot above the word being sung, bouncing. The classic.'
	},
	{
		id: 'steady',
		label: 'Steady dot',
		needsWords: true,
		note: 'The same dot without the bounce. Calmer on a big screen across a room.'
	},
	{
		id: 'underline',
		label: 'Underline',
		needsWords: true,
		note: 'A bar under the word being sung. Reads as position without anything moving.'
	},
	{
		id: 'off',
		label: 'No marker',
		needsWords: false,
		note: 'Colour alone carries the current word. The least busy option, and the only one line sync can honour.'
	}
];

export const DEFAULT_LYRICS_BALL: LyricsBallStyleId = 'bounce';

export function getLyricsBallStyle(id: string): LyricsBallStyle | undefined {
	return LYRICS_BALL_STYLES.find((s) => s.id === id);
}

export function isValidLyricsBall(id: unknown): id is LyricsBallStyleId {
	return typeof id === 'string' && getLyricsBallStyle(id) !== undefined;
}

/**
 * How the current lyric is lit.
 *
 * `granularity` mirrors `SyncMode.granularity` deliberately — that is the axis the clamp compares
 * along. A `'word'` treatment under a `'line'` sync mode is asking for data that was never computed.
 *
 * Deliberately NOT included: a left-to-right sweep across each word. All an aligner gives us is a
 * start and an end per word, so a partial wipe animates sub-word detail nobody measured — and on ASR
 * text those bounds are themselves approximate. `SYNC_MODES` above states what forced alignment buys
 * as "per-word highlighting", which is word-level marks, not sub-word ones.
 */
export type LyricsHighlightId = 'word' | 'line' | 'off';

export interface LyricsHighlight {
	id: LyricsHighlightId;
	label: string;
	/** The timing granularity this treatment needs. Compared against the global sync mode's. */
	granularity: 'word' | 'line';
	note: string;
}

export const LYRICS_HIGHLIGHTS: readonly LyricsHighlight[] = [
	{
		id: 'word',
		label: 'Word by word',
		granularity: 'word',
		note: 'Each word lights as it comes: dim ahead, pink now, white once sung.'
	},
	{
		id: 'line',
		label: 'Whole line',
		granularity: 'line',
		note: 'Lights the current line and no more. Better when word timing is patchy — a stale word held for five seconds reads as broken, a line does not.'
	},
	{
		id: 'off',
		label: 'Just the words',
		granularity: 'line',
		note: 'No highlight at all. The scrolling reel alone shows where you are.'
	}
];

export const DEFAULT_LYRICS_HIGHLIGHT: LyricsHighlightId = 'word';

export function getLyricsHighlight(id: string): LyricsHighlight | undefined {
	return LYRICS_HIGHLIGHTS.find((h) => h.id === id);
}

export function isValidLyricsHighlight(id: unknown): id is LyricsHighlightId {
	return typeof id === 'string' && getLyricsHighlight(id) !== undefined;
}

/**
 * Display lead, in ms: how far AHEAD of the audio the highlight runs.
 *
 * Replaces the hardcoded `LYRICS_LEAD_SEC = 0.3` in the TV's lyrics.ts, whose own comment already
 * argued for this scope ("a presentation preference that can be retuned per room without recomputing
 * anything"). A singer has to SEE a word before singing it, so lighting it exactly at its onset is
 * already late, and CTC onsets on sustained sung vowels tend to land late themselves.
 *
 * Applied at display time, so it COMPOSES WITH rather than replaces any per-song measured offset: a
 * fitted offset corrects for the recording, this corrects for the screen and the crowd in front of it.
 */
export const DEFAULT_LYRICS_LEAD_MS = 300;
export const MAX_LYRICS_LEAD_MS = 1500;
