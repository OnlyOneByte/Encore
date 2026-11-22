// The two PRODUCTION knobs on the lyrics half of a process, plus the PRESENTATION knobs further down.
// Scopes: docs/SERVER.md#settings-scopes. Registry rules: docs/SERVER.md#registries-and-the-quality-ladder.

import { makeRegistry } from '../core/registry';

/** A faster-whisper model token, passed straight to the loader. The canonical sizes only — the English-only
 *  variants are absent because songs arrive in any language, and unverified checkpoints because an unverified
 *  token is a process that fails at model load. */
export type AsrModelId = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';

export interface AsrModel {
	id: AsrModelId;
	label: string;
	/** Published parameter count — a FACT about the checkpoint, never a measured cost. Do not add an rtFactor
	 *  here until someone has timed these on the target hardware. */
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

/** Must match the worker's own default, so a frame that omits the field resolves the same either side. */
export const DEFAULT_ASR_MODEL: AsrModelId = 'base';

const asrRegistry = makeRegistry(ASR_MODELS);

export function getAsrModel(id: string): AsrModel | undefined {
	return asrRegistry.get(id);
}

export function isValidAsrModel(id: string): id is AsrModelId {
	return asrRegistry.isValid(id);
}

/** How a song's words get their timestamps. */
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

// PRESENTATION, from here down. These registries live beside `SYNC_MODES` because they are COUPLED to it: a
// room may only render at or below the granularity the global mode produced, and keeping the registry beside
// its constraint is what stops the two drifting. The clamp is applied by `resolveLyricsPresentation`.

/** The mark that tracks the word being sung. `needsWords` is a load-bearing FIELD the resolver reads, not
 *  documentation. See docs/SERVER.md#registries-and-the-quality-ladder. */
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

/** How the current lyric is lit. `granularity` MIRRORS `SyncMode.granularity`, which is the axis the clamp
 *  compares along. A left-to-right sweep is deliberately absent: an aligner gives only a start and an end per
 *  word, so a partial wipe animates sub-word detail nobody measured. */
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
 * Display lead, in ms, applied at DISPLAY time so it COMPOSES WITH any per-song measured offset.
 *
 * 40 ms, AND THE REASON IS THAT THE EYE'S TOLERANCE IS ASYMMETRIC (ITU-R BT.1359, lip-sync detectability:
 * video LATE of audio is noticed at about −45 ms, video EARLY at about +125 ms — nearly three times the
 * slack on the early side). A karaoke highlight is the same perceptual problem: a word that lights after it
 * is sung reads as broken, a word that lights a hair early reads as correct. So the midpoint of the
 * tolerance band is not zero, and a timing distribution centred on zero spends half its mass on the
 * expensive side.
 *
 * MEASURED ON THE TREE THAT SHIPS, and 40 ms is the ARGMAX rather than a round number taken on faith: over
 * the 5693 hand-timed word onsets of the 20-song JamendoLyrics bench corpus
 * (docs/benchmarks/forced-alignment; swept at 5 ms steps), the share
 * of published word onsets inside the asymmetric band peaks at exactly 40 ms in every population a room can
 * be in — a claim-anchored document 73.2% -> 78.6%, the same songs decoded blind 73.2% -> 78.6%, a jittered
 * claim 67.8% -> 72.6%. The curve is a PLATEAU and not a knife edge (30 / 40 / 50 ms read 78.5 / 78.6 / 78.2),
 * so a few ms either way is free — but the TV latency flagged below is not a few ms, and an EFFECTIVE lead of
 * zero gives the whole 5.4 points back.
 *
 * AND EVERY EXISTING ROOM WAS BACKFILLED TO IT, which a changed default does not do by itself:
 * `SettingsRepository.setRoom` writes every column on every save and `getRoom`
 * returns the stored row verbatim, so nothing reads the column default at runtime and any room that had ever
 * touched a TV or lyrics setting would have kept an effective lead of zero — the 5.4 points delivered to new
 * rooms only, two rooms on one install rendering differently, and nothing in the UI saying why.
 * `drizzle/0001_lyrics_lead_default.sql` therefore carries `UPDATE room_settings SET lyrics_lead_ms = 40
 * WHERE lyrics_lead_ms = 0`, which is honest for exactly one reason and only in the pre-release window: the
 * knob shipped at 0, so a stored 0 and the old default are indistinguishable and nobody can have chosen it
 * against a measurement that did not exist. A room that wants 0 sets it again and keeps it.
 *
 * THE FIRST MEASUREMENT WAS 66.0% -> 75.0% AND IT STILL REPRODUCES — on the tree it was measured on, which
 * is no longer this one. Re-scored off its own cached emission matrices (the old frame clock, the base
 * bundle, its own 40 ms `ONSET_LEAD_SEC`): 66.01% -> 74.95%, bias +3.7 ms. Since then the frame clock was
 * re-fitted and the default bundle flipped to HuBERT-Large, which moved the distribution — onset bias +3.7 ms
 * -> -3.4 ms, within 100 ms 78.7% -> 82.8% — so the band is fuller before any lead and the lead buys 5.4
 * points instead of 9. The DECISION survives the move intact; only the two percentages are this tree's.
 *
 * THIS IS A DISPLAY COMPENSATION AND NOT A TIMING CORRECTION, which is why it lives here and not in the
 * worker. The worker's own `generate.ONSET_LEAD_SEC` (30 ms, re-fitted on the exact 20 ms frame grid)
 * is ACOUSTIC TRUTH — it removes the measured LATENESS of wav2vec2/HuBERT character onsets, bias +25.3 ms
 * before it and −3.1 ms after on the re-fit's base-bundle column (−3.4 ms on a HuBERT-Large claim-anchored
 * document, −7.0 ms blind) — and moving it would make the published artifact lie about where the words
 * are, for every consumer including the bench. Two leads, two jobs; they compose because they are applied in
 * different layers.
 *
 * STILL OWED, AND THE EXACT VALUE SHOULD NOT BE TRUSTED UNTIL IT IS PAID: the TV's own VIDEO LATENCY is
 * unmeasured. BT.1359's band is about the audio and the picture a viewer perceives, so the number that
 * belongs here is 40 ms MINUS whatever the room's display pipeline (browser compositor, HDMI chain, the
 * panel's own processing, which on a consumer TV in a non-game mode is commonly 20–100 ms) already delays
 * the highlight by. A measurement — a camera or a photodiode against the audio out — would either confirm
 * this or show that the pipeline has already spent the budget. `MAX_LYRICS_LEAD_MS` is the per-room knob
 * that lets a room fix it in the meantime.
 *
 * WHAT THE BENCH READS IS STILL ZERO, deliberately: `tv/lyrics.ts` `LYRICS_LEAD_SEC` is the overlay's
 * default when no room settings reach it, the bench's TV port reads that constant (its parity fixture pins
 * it), and every recorded `highlight` row therefore measures the ARTIFACT's own accuracy rather than a
 * room's display compensation. AND THE TWO METRICS DISAGREE ABOUT THIS LEAD, which is the real reason the
 * policy stays out of the port: measured on the bench's own published documents, folding 40 ms in would COST
 * `highlight` about 2.7 points (80.9 -> 78.2 at `truth`) — it scores OVERLAP with the sung span, and our
 * onsets are already 3.4 ms early, so earliness only subtracts — while the perceptual band above pays for
 * earliness up to 125 ms. An alignment reject-if must not move because a room compensates its panel.
 */
export const DEFAULT_LYRICS_LEAD_MS = 40;
export const MAX_LYRICS_LEAD_MS = 1500;

// The reel's TYPE, as opposed to the marks on it. Everything here is a BOUNDED ADJUSTMENT on the computed
// scale, never a replacement, which is why every range carries a floor.
// See docs/SERVER.md#registries-and-the-quality-ladder.

/** Font for the lyric reel. Every stack is LOCALLY AVAILABLE — no webfont, no CDN — because the box may have
 *  no route out, and each ends in a generic family so it degrades rather than failing. */
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

/** Letter case, applied as `text-transform`, so it is PRESENTATION-ONLY: the DOM text, the per-word spans and
 *  the marker are untouched. */
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

/** Text size as a PERCENT of the computed scale, never an absolute. MIN equals the neutral point, because the
 *  neutral render IS the legibility floor after the `LYRICS_SCALE_BASE` fold. See
 *  docs/SERVER.md#registries-and-the-quality-ladder. */
export const DEFAULT_LYRICS_SCALE_PCT = 100;
export const MIN_LYRICS_SCALE_PCT = 100;
export const MAX_LYRICS_SCALE_PCT = 300;

/** The neutral-point fold: the rendered multiplier is `(scalePct / 100) * LYRICS_SCALE_BASE`. Named rather than
 *  inlined, so a test can assert the neutral render against a hard number. */
export const LYRICS_SCALE_BASE = 0.8;

/** How many lines show before and after the current one, INDEPENDENT because sung lines are continuity and
 *  coming lines are preparation. Capped: past these the type must shrink to fit. */
export const DEFAULT_LYRICS_LINES_BEFORE = 2;
export const DEFAULT_LYRICS_LINES_AFTER = 2;
export const MAX_LYRICS_LINES_BEFORE = 3;
export const MAX_LYRICS_LINES_AFTER = 4;
