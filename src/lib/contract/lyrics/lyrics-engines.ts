// The two knobs on the LYRICS half of a process: which model reads the words, and how those words get
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

import { makeRegistry } from '../core/registry';

/**
 * A faster-whisper model token, passed straight to `whisperx.load_model()`.
 *
 * The canonical five sizes only. Deliberately NOT included: the `.en` English-only variants (a
 * karaoke box gets handed songs in any language, and the ASR tier detects rather than assumes) and
 * the `distil-*` checkpoints (worth measuring, but an unverified token here becomes a process that fails
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
	 * It is NOT a measured process cost on any box — contrast `SeparatorCost` in separators.ts, which
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
		note: "The first size worth trusting with sung words. ~3x base's weights for a modest slice of the process."
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
		note: 'Best available text. Only sane with a GPU, or on a box that processes ahead of the party rather than during it.'
	}
];

/** Matches whisperx.py's DEFAULT_MODEL, so exposing this setting changes no existing behaviour. */
export const DEFAULT_ASR_MODEL: AsrModelId = 'base';

const asrRegistry = makeRegistry(ASR_MODELS);

export function getAsrModel(id: string): AsrModel | undefined {
	return asrRegistry.get(id);
}

export function isValidAsrModel(id: string): id is AsrModelId {
	return asrRegistry.isValid(id);
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
		note: "Skip alignment and use each source's own line timings. No second ML pass, so a process finishes sooner — but the ball cannot follow individual words. Only as good as the source: an LRC from a different upload of the song is timed for that recording, not this one."
	}
];

export const DEFAULT_SYNC_MODE: SyncModeId = 'forced';

const syncModeRegistry = makeRegistry(SYNC_MODES);

export function getSyncMode(id: string): SyncMode | undefined {
	return syncModeRegistry.get(id);
}

export function isValidSyncMode(id: string): id is SyncModeId {
	return syncModeRegistry.isValid(id);
}

// ── presentation ────────────────────────────────────────────────────────────
// The two knobs above are PRODUCTION: they decide what timing data a process produces, and they are
// global because they cost model weights and RAM. The two below are PRESENTATION: they decide how
// data that already exists gets drawn on one room's TV, and they are room-scoped for the same reason
// `tvProgressStyle` is — a staging choice for one party's screen.
//
// They live here rather than beside `tvProgressStyle` in settings.ts because they are COUPLED to
// `SYNC_MODES` above: a room can only render at or below the granularity the global mode produced.
// Keeping the registry and the constraint it is checked against in one file is what stops the two
// drifting. The resolver that applies the clamp is `resolveLyricsPresentation` in settings.ts,
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

export const DEFAULT_LYRICS_BALL: LyricsBallStyleId = 'off';

const lyricsBallRegistry = makeRegistry(LYRICS_BALL_STYLES);

export function getLyricsBallStyle(id: string): LyricsBallStyle | undefined {
	return lyricsBallRegistry.get(id);
}

export function isValidLyricsBall(id: unknown): id is LyricsBallStyleId {
	return lyricsBallRegistry.isValid(id);
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
		label: 'Just scroll',
		granularity: 'line',
		note: 'No highlight at all. The scrolling reel alone shows where you are.'
	}
];

export const DEFAULT_LYRICS_HIGHLIGHT: LyricsHighlightId = 'word';

const lyricsHighlightRegistry = makeRegistry(LYRICS_HIGHLIGHTS);

export function getLyricsHighlight(id: string): LyricsHighlight | undefined {
	return lyricsHighlightRegistry.get(id);
}

export function isValidLyricsHighlight(id: unknown): id is LyricsHighlightId {
	return lyricsHighlightRegistry.isValid(id);
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
 *
 * DEFAULT IS 0: a single global lead is a band-aid that cannot be right across tempos and
 * masks per-song mismatch. The per-room `lyricsLeadMs` setting remains the opt-in for a room that
 * wants a lead; only the shipped default changed.
 */
export const DEFAULT_LYRICS_LEAD_MS = 0;
export const MAX_LYRICS_LEAD_MS = 1500;

// ── text ────────────────────────────────────────────────────────────────────
// The reel's TYPE, as opposed to the marks drawn on it. Room-scoped for the same reason the ball and
// the highlight are, and gathered here beside them so one file answers "what can a room change about
// the lyrics".
//
// An early change gave the reel a distance-based scale (`clamp(3.1rem, 6.4vh, 6rem)`) and the PR that added the
// ball/highlight settings deliberately kept size and row count OUT, on the grounds that re-exposing
// them would let a party undo that legibility work. That reasoning holds for RAW values, so what is
// exposed here is a BOUNDED ADJUSTMENT on top of the computed scale rather than a replacement for it.
// Every range below has a floor for that reason; they are not arbitrary.

/**
 * Font for the lyric reel.
 *
 * Every stack is LOCALLY AVAILABLE — no webfont, no CDN, nothing fetched. That is the same constraint
 * that made the icon system vendor path geometry instead of taking a font dependency: the box is a LAN
 * deployment that may have no route out, and a missing glyph on this deployment has already rendered
 * as a tofu box. So each option ends in a generic family and degrades rather than failing.
 *
 * `stack: 'inherit'` is not a cop-out — it is the honest way to say "whatever the app already uses",
 * which keeps the default identical to today without duplicating app.css's stack here where it would
 * drift.
 */
export type LyricsFontId = 'system' | 'grotesk' | 'serif' | 'mono';

export interface LyricsFont {
	id: LyricsFontId;
	label: string;
	/** A CSS font-family value, or `inherit` to take the app's own stack. */
	stack: string;
	note: string;
}

export const LYRICS_FONTS: readonly LyricsFont[] = [
	{
		id: 'system',
		label: 'System',
		stack: 'inherit',
		note: "The same face as the rest of the app. Always available, whatever the TV's browser has."
	},
	{
		id: 'grotesk',
		label: 'Wide sans',
		stack: "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
		note: 'Slightly wider letterforms, which hold up better read from across a room.'
	},
	{
		id: 'serif',
		label: 'Serif',
		stack: "Georgia, 'Times New Roman', serif",
		note: 'Higher stroke contrast. Easier on the eye on a bright screen, harder on a dim one.'
	},
	{
		id: 'mono',
		label: 'Monospace',
		stack: "ui-monospace, 'Courier New', monospace",
		note: 'Even letter widths, so a line does not shift as words light up. Fits fewer words per row.'
	}
];

export const DEFAULT_LYRICS_FONT: LyricsFontId = 'system';

const lyricsFontRegistry = makeRegistry(LYRICS_FONTS);

export function getLyricsFont(id: string): LyricsFont | undefined {
	return lyricsFontRegistry.get(id);
}

export function isValidLyricsFont(id: unknown): id is LyricsFontId {
	return lyricsFontRegistry.isValid(id);
}

/**
 * Letter case, applied as `text-transform`.
 *
 * Presentation-only: it does not change the DOM text, so the per-word spans, the marker and the
 * highlight are all untouched. Both non-default options cost something real, and the notes say so
 * rather than presenting three equivalent styles — a room should be able to choose them, and should
 * not be surprised afterwards.
 */
export type LyricsCaseId = 'natural' | 'upper' | 'lower';

export interface LyricsCase {
	id: LyricsCaseId;
	label: string;
	/** The `text-transform` value. `none` leaves the source text alone. */
	transform: 'none' | 'uppercase' | 'lowercase';
	note: string;
}

export const LYRICS_CASES: readonly LyricsCase[] = [
	{
		id: 'natural',
		label: 'As written',
		transform: 'none',
		note: 'The words exactly as the lyrics source has them.'
	},
	{
		id: 'upper',
		label: 'ALL CAPS',
		transform: 'uppercase',
		note: 'Uniform and bold, but every line gets wider so more of them wrap — and running text is slower to read without ascenders to give a word its shape.'
	},
	{
		id: 'lower',
		label: 'all lowercase',
		transform: 'lowercase',
		note: 'Softer look. Loses proper nouns and the word "I", which for lyrics is a change to the words rather than to the styling.'
	}
];

export const DEFAULT_LYRICS_CASE: LyricsCaseId = 'natural';

const lyricsCaseRegistry = makeRegistry(LYRICS_CASES);

export function getLyricsCase(id: string): LyricsCase | undefined {
	return lyricsCaseRegistry.get(id);
}

export function isValidLyricsCase(id: unknown): id is LyricsCaseId {
	return lyricsCaseRegistry.isValid(id);
}

/**
 * Text size as a PERCENT of the computed distance-based scale — never an absolute size.
 *
 * A stored pixel size would discard the `vh` term in `clamp(3.1rem, 6.4vh, 6rem)`, so the same room
 * would render wrong the moment the TV's resolution changed. That is precisely the bug PR #8's scale
 * fixed, and a settings field is not worth reintroducing it. A multiplier keeps the adaptive scale and
 * layers the room's preference on top.
 *
 * An integer percent rather than a float factor because every other numeric in `RoomSettings` is an
 * integer and a REAL column for one field is not worth the schema asymmetry.
 *
 * The floor is the legibility guard, deliberately not lower: below it the reel stops being readable
 * from a couch, which is the whole thing the scale exists to guarantee.
 *
 * REBASED: the neutral point was folded down by `LYRICS_SCALE_BASE`, so a stored `100` now
 * renders what `80` rendered before this change — the "80% is the new 100%" fold. The number the room
 * sees keeps reading `100` at the neutral point; only what it renders moved. The stored column keeps
 * its meaning as a raw integer (default `100`, no migration), so every existing room's lyrics render
 * 20% smaller than before — the deliberate intent of the rebase, not a size the room asked for and
 * lost. Because `100` renders the old legibility floor, the MIN is `100`: there is no honest room
 * below it, the floor IS the neutral point now. The ceiling is raised a long way (a `300` renders
 * `2.4×`, well past the old `1.6×`) — the reel's own `max-height` cap and edge-fade mask (see
 * LyricsOverlay.svelte) absorb an extreme setting on a short panel, so a big MAX degrades honestly
 * rather than spilling the reel back down over the cards.
 */
export const DEFAULT_LYRICS_SCALE_PCT = 100;
export const MIN_LYRICS_SCALE_PCT = 100;
export const MAX_LYRICS_SCALE_PCT = 300;

/**
 * The neutral-point fold for `lyricsScalePct`. The rendered multiplier is
 * `(scalePct / 100) * LYRICS_SCALE_BASE`, so the neutral `100` renders `0.8×` — exactly what the old
 * `80` rendered — while the number shown to the room stays `100`. Kept as a named constant, not a
 * literal at the call site, so the render arithmetic and this rationale live together and a test can
 * assert the neutral render against a hard number rather than re-deriving it with the same operation.
 */
export const LYRICS_SCALE_BASE = 0.8;

/**
 * How many lines show before and after the current one.
 *
 * Independent rather than one "context" number, because the two are not equally useful: lines already
 * sung are continuity, lines still coming are preparation, and a room that wants to see what is next
 * without a history is a reasonable ask.
 *
 * Capped because the reel occupies a fixed fraction of the screen. Past these counts the type has to
 * shrink to fit, which would undo the distance-legibility work through the back door — the same reason
 * `lyricsScalePct` has a floor.
 */
export const DEFAULT_LYRICS_LINES_BEFORE = 2;
export const DEFAULT_LYRICS_LINES_AFTER = 2;
export const MAX_LYRICS_LINES_BEFORE = 3;
export const MAX_LYRICS_LINES_AFTER = 4;
