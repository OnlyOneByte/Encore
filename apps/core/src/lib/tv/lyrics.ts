// Pure karaoke-timing logic for the TV lyrics overlay (M8-C2). No DOM, no Svelte — so the
// word-highlight math is unit-testable independently of rendering. Consumes the word-timed artifact
// the worker publishes (M7-C8 `normalize_lyrics`): { language, lines:[{start,end,text,words:[…]}], words:[…] }.
// All times are SECONDS (the worker rounds to ms). Model output is UNTRUSTED, so every accessor is
// defensive: missing/NaN bounds never throw, they just read as "not yet sung".

export interface LyricWord {
	word: string;
	start: number;
	end: number;
}
export interface LyricLine {
	start: number | null;
	end: number | null;
	text: string;
	words: LyricWord[];
}
export interface LyricsDoc {
	language: string | null;
	lines: LyricLine[];
	words: LyricWord[];
}

const num = (v: unknown): number | null =>
	typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Parse an untrusted `/media/*.json` payload into a LyricsDoc, dropping malformed lines/words.
 * Returns null when there is nothing word-timed to show (so the overlay can no-op cleanly).
 */
export function parseLyricsDoc(raw: unknown): LyricsDoc | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const rawLines = Array.isArray(r.lines) ? r.lines : [];
	const lines: LyricLine[] = [];
	const flat: LyricWord[] = [];
	for (const rl of rawLines) {
		if (!rl || typeof rl !== 'object') continue;
		const l = rl as Record<string, unknown>;
		const words: LyricWord[] = [];
		for (const rw of Array.isArray(l.words) ? l.words : []) {
			if (!rw || typeof rw !== 'object') continue;
			const w = rw as Record<string, unknown>;
			const start = num(w.start);
			const end = num(w.end);
			if (typeof w.word !== 'string' || !w.word.trim() || start === null || end === null) continue;
			const word = { word: w.word, start, end };
			words.push(word);
			flat.push(word);
		}
		const text =
			typeof l.text === 'string' && l.text.trim()
				? l.text
				: words.map((w) => w.word).join(' ');
		if (!text.trim() && words.length === 0) continue;
		lines.push({ start: num(l.start), end: num(l.end), text, words });
	}
	if (lines.length === 0) return null;
	const resegmented = lines.flatMap((l) => resegmentLine(l));
	return {
		language: typeof r.language === 'string' ? r.language : null,
		lines: resegmented,
		words: flat
	};
}

// ── pause-based line splitting ────────────────────────────────────────────────
//
// WHY. Whisper `transcribe()` returns SEGMENTS, and a segment is a VAD/decoder chunk of up to ~30s —
// not a lyric line. One real segment from Creep was:
//
//   "So fucking special I wish I was special But I'm a creep I'm a widow What the hell am I to hear
//    I don't belong here"
//
// i.e. four lyric lines as one blob, which the overlay then wrapped at arbitrary points. Nobody can
// sing from that. But the fix is already in the data: after forced alignment every word has timings,
// so the PAUSES between words are exactly where the lyric lines break.
//
// Done in the display layer rather than in the worker on purpose: it fixes every artifact that already
// exists, with no re-cook and no second ML pass. The artifact keeps whisper's raw segmentation, which
// is honest provenance; how it reads on a TV is a presentation concern.

/** A gap at least this long between two words reads as a line break. */
export const LINE_GAP_SEC = 0.45;
/** Even with no pause, break a run longer than this so a line never wraps to three rows. */
export const LINE_MAX_CHARS = 42;
/** Only resegment when the timed words actually cover the line's text (see below). */
const COVERAGE_MIN = 0.8;

function lineFromWords(words: LyricWord[]): LyricLine {
	return {
		start: words[0]!.start,
		end: words[words.length - 1]!.end,
		text: words.map((w) => w.word).join(' '),
		words
	};
}

/**
 * Split one line into lyric-sized lines at pauses, and at `LINE_MAX_CHARS` when a run has no pause.
 *
 * REFUSES to split when the timed words don't cover the line's own text (`COVERAGE_MIN`).
 * `normalize_lyrics` drops words the aligner left un-timed, so a poorly-aligned line can have words[]
 * much shorter than text — rebuilding the line from words there would silently DELETE lyrics from the
 * screen. Showing one badly-wrapped line beats showing a line with words missing.
 */
export function resegmentLine(
	line: LyricLine,
	gapSec: number = LINE_GAP_SEC,
	maxChars: number = LINE_MAX_CHARS
): LyricLine[] {
	if (line.words.length < 2) return [line];
	const joined = line.words.map((w) => w.word).join(' ');
	if (joined.length < line.text.trim().length * COVERAGE_MIN) return [line];

	const out: LyricLine[] = [];
	let cur: LyricWord[] = [];
	for (const w of line.words) {
		const prev = cur[cur.length - 1];
		if (prev) {
			const gap = w.start - prev.end;
			const chars = cur.reduce((n, x) => n + x.word.length + 1, 0) + w.word.length;
			if (gap >= gapSec || chars > maxChars) {
				out.push(lineFromWords(cur));
				cur = [];
			}
		}
		cur.push(w);
	}
	if (cur.length) out.push(lineFromWords(cur));
	return out.length ? out : [line];
}

/** [start,end] of a line — its own bounds, else derived from its first/last word. null if unknown. */
export function lineBounds(line: LyricLine): [number, number] | null {
	const start = line.start ?? line.words[0]?.start ?? null;
	const end = line.end ?? line.words[line.words.length - 1]?.end ?? null;
	if (start === null || end === null) return null;
	return [start, end];
}

/**
 * Index of the line to spotlight at `pos` (seconds):
 *  • the line currently being sung (start ≤ pos < end), else
 *  • the last line that has already ended (so a finished line stays lit through a gap), else
 *  • 0 before the first line begins (pre-roll shows the opening line).
 * Lines are assumed in chronological order (the worker emits them so).
 */
export function activeLineIndex(lines: LyricLine[], pos: number): number {
	if (lines.length === 0) return -1;
	let active = 0;
	for (let i = 0; i < lines.length; i++) {
		const b = lineBounds(lines[i]);
		if (!b) continue;
		const [start, end] = b;
		if (pos >= start && pos < end) return i; // currently singing this line
		if (pos >= end) active = i; // passed it — remember as the most-recent
		else break; // pos < start of a future line → stop; `active` holds the last sung line
	}
	return active;
}

/**
 * How far a word has been sung at `pos`, 0..1 (the "bouncing-ball" fill fraction across the word):
 * 0 before it starts, 1 after it ends, linear in between. Degenerate/zero-length words snap 0→1.
 */
export function wordFill(word: LyricWord, pos: number): number {
	if (pos >= word.end) return 1; // fully sung (also snaps a zero-length word to 1 once reached)
	if (pos <= word.start) return 0;
	const span = word.end - word.start;
	if (span <= 0) return 1;
	return (pos - word.start) / span;
}

/** Index of the word within a line being sung at `pos` (the "ball" position); -1 if none/between. */
export function activeWordIndex(line: LyricLine, pos: number): number {
	for (let i = 0; i < line.words.length; i++) {
		const w = line.words[i];
		if (pos >= w.start && pos < w.end) return i;
	}
	return -1;
}

// ── honesty about where the words came from (B-3-C6) ──────────────────────────
import { isAuthoritativeText, type LyricsCandidate } from '@encore/shared';

/** The provenance slice the overlay needs — a Pick of the stored candidate. */
export type LyricsProvenance = Pick<LyricsCandidate, 'textSource' | 'textConfidence' | 'timing'>;

/**
 * The caption to show alongside the lyrics, or null when none is warranted.
 *
 * Only auto-transcribed text gets a notice, and it gets one precisely BECAUSE the result looks
 * finished: force-aligned ASR renders a perfect bouncing ball over words that may be wrong, which is
 * the most misleading state the overlay can be in. Authoritative text needs no caption, and coarse
 * timing needs none either — that is visible on its own.
 *
 * Unknown provenance (an artifact from before candidate tracking) returns null: we cannot claim the
 * text is a guess, and we cannot claim it is verified, so we say nothing rather than something false.
 */
export function lyricsNotice(p: LyricsProvenance | null | undefined): string | null {
	if (!p) return null;
	return isAuthoritativeText(p) ? null : 'auto-transcribed · words may be wrong';
}

/** Should the lyrics render in the "not verified" visual treatment? */
export function isAutoTranscribed(p: LyricsProvenance | null | undefined): boolean {
	return !!p && !isAuthoritativeText(p);
}
