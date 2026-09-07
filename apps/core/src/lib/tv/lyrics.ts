// Pure karaoke-timing logic for the TV lyrics overlay. No DOM, no Svelte — so the
// word-highlight math is unit-testable independently of rendering. Consumes the word-timed artifact
// the worker publishes (`normalize_lyrics`): { language, lines:[{start,end,text,words:[…]}], words:[…] }.
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
	/**
	 * A second-script rendering of this line the source shipped alongside the original — the pinyin
	 * under a Chinese line (issue #431). Present ONLY when the LRCLIB record interleaved one; a
	 * single-script line leaves it undefined. Display-only: it carries no timings and drives no ball.
	 */
	romanization?: string;
}
export interface LyricsDoc {
	language: string | null;
	lines: LyricLine[];
	words: LyricWord[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

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
		const text = typeof l.text === 'string' && l.text.trim() ? l.text : words.map((w) => w.word).join(' ');
		if (!text.trim() && words.length === 0) continue;
		const line: LyricLine = { start: num(l.start), end: num(l.end), text, words };
		if (typeof l.romanization === 'string' && l.romanization.trim()) line.romanization = l.romanization;
		lines.push(line);
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

/**
 * How far AHEAD of the audio the highlight runs, in seconds.
 *
 * WhisperX word timings are true onsets/offsets — `align()` is wav2vec2 CTC forced alignment, so
 * `start` is where the word begins, not its middle, and the vocals stem shares the mix's timeline.
 * The overlay still reads as "behind" without a lead, for two reasons that both want this knob:
 *
 *   1. A singer must SEE the word before singing it. Lighting it exactly at its onset is already late;
 *      commercial karaoke leads the vocal by a few hundred ms for the same reason.
 *   2. CTC onsets on sustained sung vowels tend to land slightly late, since the model anchors on the
 *      clearest part of the phoneme rather than its attack.
 *
 * Applied at DISPLAY time, not baked into the artifact: the artifact should stay a faithful record of
 * where the words actually are, and this is a presentation preference that can be retuned per room
 * without recomputing anything.
 */
export const LYRICS_LEAD_SEC = 0.3;

/** A gap at least this long between two words reads as a line break. */
export const LINE_GAP_SEC = 0.45;
/** Even with no pause, break a run longer than this so a line never wraps to three rows. */
export const LINE_MAX_CHARS = 42;
/** Only resegment when the timed words actually cover the line's text (see below). */
const COVERAGE_MIN = 0.8;
/**
 * A single-word line sung for less than this gets folded into an adjacent line.
 *
 * Splitting purely on pauses produces these: a held note or a breath after one word ("Yeah", "Oh")
 * becomes its own line, which flashes past too fast to read and steals a whole row of the reel from
 * the words actually being sung. The word is not wrong, it just does not deserve a line.
 */
export const ORPHAN_MAX_SEC = 1.0;

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
 * ONLY fires on a line that is actually too long (`splitAboveChars`, defaulting to `maxChars`).
 *
 * WHY THE GUARD. A pause is evidence of a line break only when there is a reason to look for one.
 * Applied to every line it splits on any held note or breath, turning a short correct line into two
 * flashing rows (`coalesceOrphans` existed largely to undo that). The blob case is now handled
 * UPSTREAM in the worker (lyrics_presplit.py), so this stays the safety net it should always have
 * been: it catches artifacts written before that change and any over-long line that slips through,
 * and leaves a line that already fits a row alone — still fixing existing artifacts with no re-cook.
 *
 * REFUSES to split when the timed words don't cover the line's own text (`COVERAGE_MIN`).
 * `normalize_lyrics` drops words the aligner left un-timed, so a poorly-aligned line can have words[]
 * much shorter than text — rebuilding the line from words there would silently DELETE lyrics from the
 * screen. Showing one badly-wrapped line beats showing a line with words missing.
 */
export function resegmentLine(
	line: LyricLine,
	gapSec: number = LINE_GAP_SEC,
	maxChars: number = LINE_MAX_CHARS,
	splitAboveChars: number = maxChars
): LyricLine[] {
	if (line.text.trim().length <= splitAboveChars) return [line];
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
	return out.length ? coalesceOrphans(out) : [line];
}

/**
 * Fold away single-word lines that own the screen for under `ORPHAN_MAX_SEC`, merging each into
 * whichever neighbour it is CLOSER TO IN TIME (previous wins a tie).
 *
 * Nearest-in-time rather than always-previous, because both directions occur and the gaps say which:
 *   • "...I don't belong | here"      → "here" is the tail of the phrase before it, so it merges BACK
 *   • "I | want a perfect body."      → "I" is the head of the phrase after it, so it merges FORWARD
 * Always appending to the previous line would produce "I want to have control. I", which is worse than
 * the row it was trying to remove. The pause lengths already encode which phrase the word belongs to.
 *
 * A merge can push a line past `LINE_MAX_CHARS`, and that is the right trade: one extra short word on
 * an existing line reads far better than a row that flashes "Yeah" for 800ms.
 */
function coalesceOrphans(input: LyricLine[]): LyricLine[] {
	if (input.length < 2) return input;
	const lines = [...input]; // local copy: the forward-merge rewrites the next entry as it goes
	const out: LyricLine[] = [];
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i]!;
		const prev = out[out.length - 1];
		const next = lines[i + 1];
		/*
		 * Measure the word's own SUNG duration, not the time until the next line starts — trailing
		 * silence would let a word followed by a long pause survive as a "long-lived" line, and silence
		 * does not make a lone word read better. Duration also keeps a genuinely held note (2s) as its
		 * own line.
		 */
		// Read timings off the WORDS, not the line bounds: LyricLine.start/end are nullable (a parsed
		// line need not carry them) whereas a word is only kept when both are finite.
		const first = l.words[0];
		const sung = first ? first.end - first.start : Infinity;
		if (l.words.length !== 1 || sung >= ORPHAN_MAX_SEC || (!prev && !next) || !first) {
			out.push(l);
			continue;
		}
		const prevEnd = prev?.words[prev.words.length - 1]?.end ?? prev?.end ?? null;
		const nextStart = next?.words[0]?.start ?? next?.start ?? null;
		const gapBefore = prevEnd === null ? Infinity : first.start - prevEnd;
		const gapAfter = nextStart === null ? Infinity : nextStart - first.end;
		if (gapBefore <= gapAfter) {
			out.push(lineFromWords([...out.pop()!.words, ...l.words])); // merge BACK
		} else {
			// merge FORWARD: carry the word into the next line as we reach it
			lines[i + 1] = lineFromWords([...l.words, ...next!.words]);
		}
	}
	return out;
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
		if (pos >= start && pos < end) return i;
		if (pos >= end) active = i;
		else break;
	}
	return active;
}

/** Index of the word within a line being sung at `pos` (the "ball" position); -1 if none/between. */
export function activeWordIndex(line: LyricLine, pos: number): number {
	for (let i = 0; i < line.words.length; i++) {
		const w = line.words[i];
		if (pos >= w.start && pos < w.end) return i;
	}
	return -1;
}

// ── honesty about where the words came from ──────────────────────────
import { isAuthoritativeText, type LyricsCandidate } from '@encore/shared';

/** The provenance slice the overlay needs — a Pick of the stored candidate. */
export type LyricsProvenance = Pick<LyricsCandidate, 'textSource' | 'textConfidence' | 'timing'>;

/** Should the lyrics render in the "not verified" visual treatment? */
export function isAutoTranscribed(p: LyricsProvenance | null | undefined): boolean {
	return !!p && !isAuthoritativeText(p);
}

/**
 * The provenance TAG for the now-playing card -- names WHERE the words came from, so "these lyrics
 * are wrong" and "these lyrics are a guess" stop looking the same (issue #635, owner ruling (a):
 * provenance only, never a confidence/quality score, never interactive).
 *
 * `textSource` is the whole answer: LRCLIB and hand-pasted text are authored records, captions and
 * ASR are machine guesses, and each gets its own honest words. The amber "not verified" tint is a
 * SEPARATE axis (`isAutoTranscribed`, driven by confidence) -- this only says the source.
 *
 * Returns `null` for UNKNOWN provenance (a pre-candidate artifact, where `chosenCandidate` honestly
 * returns null): the card must then say NOTHING, not "unknown". We do not assert a source we cannot
 * trace, exactly as the amber tint stays off for the same case.
 */
export function provenanceLabel(p: LyricsProvenance | null | undefined): string | null {
	if (!p) return null;
	switch (p.textSource) {
		case 'lrclib':
			return 'LRCLIB';
		case 'captions':
			return 'From the video captions';
		case 'asr':
			return 'Auto-transcribed';
		case 'manual':
			return 'Pasted by hand';
	}
}
