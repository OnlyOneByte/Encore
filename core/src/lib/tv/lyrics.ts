// Pure karaoke-timing logic for the TV lyrics overlay. All times are SECONDS, and model output is UNTRUSTED, so
// every accessor is defensive: missing/NaN bounds never throw, they read as "not yet sung".
import { isAuthoritativeText, type LyricsCandidate, type LyricsConfidence } from '$lib/contract';

export interface LyricSyllable {
	text: string;
	start: number;
	end: number;
}
export interface LyricWord {
	word: string;
	start: number;
	end: number;
	/** Sub-word spans from the worker's char-level alignment (alignment v2). A sustained sung vowel's span
	 *  stretches with the singing, so a syllable's duration is its SUNG duration — the unit a bouncing ball
	 *  wants. Optional: v1 documents and single-syllable words carry none, and no renderer reads it yet. */
	syllables?: LyricSyllable[];
}
export interface LyricLine {
	start: number | null;
	end: number | null;
	text: string;
	words: LyricWord[];
	/** A second script the source shipped alongside the original (pinyin under a Chinese line). Display-only. */
	romanization?: string;
	// Which abstract duet PART sings this line, written only when the worker's diarization is CONFIDENT: a solo or a
	// low-confidence result leaves it undefined, which reads as one colour for the whole song. Never an identity.
	// `part` ONLY: the v2 worker wrote the diarizer's raw `speaker` on every line it could attribute, with none of the
	// song-level duet checks, so a document still carrying it is read as unattributed, not as a duet.
	part?: string;
	/** Per-line verdict from the worker's grading: `low` marks a line whose placement nothing could vouch
	 *  for (a repeated chorus with no claims to anchor WHICH occurrence — the decode can bind a repeat to the
	 *  wrong one, and the CTC trellis says how ambiguous the placement was). `wipesWords` is what
	 *  reads it; absent on v1 documents. */
	confidence?: LyricsConfidence;
}

/**
 * Should this line get the WORD-BY-WORD wipe, or only the line-level highlight?
 *
 * THE ONE READER of per-line `confidence` (a grade with no consumer is a worthless signal).
 * A word wipe is a claim about WHERE INSIDE THE LINE the singer is; a `low` grade says the worker could
 * not vouch for where the line itself sits, so a ball sweeping its words asserts precision the document
 * does not have. Lighting the whole row instead says only "this line is being sung", which is the same
 * honest reading the `line` highlight setting exists for (`.lyrics.hl-line .row.current`, and the measured
 * coverage note beside it).
 *
 * A LINE WITH NO GRADE KEEPS THE WIPE. v1 documents and any worker that did not grade carry no
 * `confidence`, and a missing field must never be read as doubt — that would silently turn the karaoke
 * sweep off for every older artifact.
 *
 * `medium` KEEPS IT TOO. The worker grades lines `high`/`low` only (the document as a whole can be
 * `medium`), so treating `medium` as doubt would be a rule with no producer.
 */
export function wipesWords(line: Pick<LyricLine, 'confidence'>): boolean {
	return line.confidence !== 'low';
}
export interface LyricsDoc {
	language: string | null;
	lines: LyricLine[];
	words: LyricWord[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parse an untrusted payload, dropping malformed lines/words. null when there is nothing to show. */
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
			const word: LyricWord = { word: w.word, start, end };
			// Syllables are OPTIONAL and untrusted like everything else here: malformed entries drop, and a
			// word whose syllables all drop is simply a word without them.
			if (Array.isArray(w.syllables)) {
				const syllables: LyricSyllable[] = [];
				for (const rs of w.syllables) {
					if (!rs || typeof rs !== 'object') continue;
					const sy = rs as Record<string, unknown>;
					const syStart = num(sy.start);
					const syEnd = num(sy.end);
					if (typeof sy.text !== 'string' || !sy.text || syStart === null || syEnd === null) continue;
					syllables.push({ text: sy.text, start: syStart, end: syEnd });
				}
				if (syllables.length > 0) word.syllables = syllables;
			}
			words.push(word);
			flat.push(word);
		}
		const text = typeof l.text === 'string' && l.text.trim() ? l.text : joinWords(words);
		if (!text.trim() && words.length === 0) continue;
		const line: LyricLine = { start: num(l.start), end: num(l.end), text, words };
		if (typeof l.romanization === 'string' && l.romanization.trim()) line.romanization = l.romanization;
		if (typeof l.part === 'string' && l.part.trim()) line.part = l.part;
		if (l.confidence === 'high' || l.confidence === 'medium' || l.confidence === 'low') line.confidence = l.confidence;
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

// PAUSE-BASED LINE SPLITTING. Whisper returns VAD/decoder SEGMENTS of up to ~30s, not lyric lines, and after forced
// alignment every word has timings, so the PAUSES are where the lines break. In the DISPLAY layer, not the worker, so
// it fixes artifacts that already exist with no re-process. See docs/FRONTEND.md#reading-a-lyrics-artifact.

/**
 * Applied at DISPLAY time, so the artifact stays a faithful record of where the words actually are. ZERO BY DEFAULT:
 * one global lead cannot be right for both a ballad and a fast rap line, and it masks text/audio mismatch.
 */
export const LYRICS_LEAD_SEC = 0;

/** The room's lead with the host's nudge for this song (`Media.lyricsOffsetMs`): words shown earlier are a longer lead. */
export function nudgedLeadSec(leadSec: number, offsetMs = 0): number {
	return leadSec - offsetMs / 1000;
}

/** A gap at least this long between two words reads as a line break. */
export const LINE_GAP_SEC = 0.45;
/** Even with no pause, break a run longer than this so a line never wraps to three rows. */
export const LINE_MAX_CHARS = 42;
/** Only resegment when the timed words actually cover the line's text (see below). */
const COVERAGE_MIN = 0.8;
// A single-word line sung for less than this is folded into a neighbour: pause splitting turns a held note or a breath
// into its own row, which flashes past unreadably and costs the reel a row the sung words need.
export const ORPHAN_MAX_SEC = 1.0;

// CHARACTERS THAT WRITE NO SPACE BESIDE THEIR OWN KIND: Han, kana, and — through `scx`, Script_Extensions —
// the CJK punctuation and the prolonged-sound mark the UCD files under "Common", plus the fullwidth
// punctuation block with its Latin letters and digits left out. HANGUL IS DELIBERATELY ABSENT: Korean spaces
// its words like Latin does, so it is only "CJK" typographically.
const CJK_JOINS = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}！-／：-＠［-｀｛-･]/u;

const lastChar = (s: string | undefined): string | undefined => (s ? [...s].at(-1) : undefined);
const firstChar = (s: string | undefined): string | undefined => (s ? [...s][0] : undefined);

/**
 * Does a space belong between these two characters? `undefined` on either side is the edge of a line.
 *
 * ONE RULE FOR BOTH RENDERERS — the reel's inter-word gap and the text `lineFromWords` rebuilds — because a
 * Japanese line joined with spaces in one and without in the other would read as two different songs. A
 * CJK/Latin boundary KEEPS its space: the two scripts mix within a line of lyrics, and running them together
 * is unreadable either way.
 */
function spaceBetweenChars(before: string | undefined, after: string | undefined): boolean {
	if (before === undefined) return false;
	if (!CJK_JOINS.test(before)) return true; // Latin and Hangul space their words, end of line included
	return after !== undefined && !CJK_JOINS.test(after);
}

/** The separator rendered AFTER word `i` of a line: '' where the next CJK character joins straight on. */
export function wordGap(words: readonly Pick<LyricWord, 'word'>[], i: number): string {
	return spaceBetweenChars(lastChar(words[i]?.word), firstChar(words[i + 1]?.word)) ? ' ' : '';
}

/** A line's words as one string, spaced by the same rule the reel renders them with. */
export function joinWords(words: readonly Pick<LyricWord, 'word'>[]): string {
	return words.map((w, i) => (i === 0 ? '' : wordGap(words, i - 1)) + w.word).join('');
}

function lineFromWords(words: LyricWord[]): LyricLine {
	return {
		start: words[0]!.start,
		end: words[words.length - 1]!.end,
		text: joinWords(words),
		words
	};
}

/**
 * Split one line at pauses, and at `LINE_MAX_CHARS` when a run has no pause. ONLY fires on a line that is actually too
 * long: applied unconditionally a pause splits on any held note and turns a correct short line into two flashing rows.
 *
 * REFUSES to split when the timed words do not cover the line's text (`COVERAGE_MIN`), because `normalize_lyrics` drops
 * un-timed words and rebuilding from `words` would silently DELETE lyrics from the screen.
 */
export function resegmentLine(
	line: LyricLine,
	gapSec: number = LINE_GAP_SEC,
	maxChars: number = LINE_MAX_CHARS,
	splitAboveChars: number = maxChars
): LyricLine[] {
	if (line.text.trim().length <= splitAboveChars) return [line];
	if (line.words.length < 2) return [line];
	// Measured with `joinWords`, not with one space everywhere: on a CJK line the spaces are characters the
	// text does not have, which inflates the coverage this refusal reads and lets a partial sheet split.
	if (joinWords(line.words).length < line.text.trim().length * COVERAGE_MIN) return [line];

	const out: LyricLine[] = [];
	let cur: LyricWord[] = [];
	for (const w of line.words) {
		const prev = cur[cur.length - 1];
		if (prev) {
			const gap = w.start - prev.end;
			const chars = joinWords([...cur, w]).length;
			if (gap >= gapSec || chars > maxChars) {
				out.push(lineFromWords(cur));
				cur = [];
			}
		}
		cur.push(w);
	}
	if (cur.length) out.push(lineFromWords(cur));
	// A duet PART belongs to the whole source line, so every row it splits into keeps it or a long duet line loses its
	// colour. `romanization` needs no carry: it appears only on line-synced docs, which are never resegmented.
	const split = out.length ? coalesceOrphans(out) : [line];
	if (line.part !== undefined) for (const l of split) l.part = line.part;
	// Same carry for the v2 per-line verdict: the grading judged the SOURCE line, and each row it split
	// into inherits that judgement — syllables need no carry, they ride on the words.
	if (line.confidence !== undefined) for (const l of split) l.confidence = line.confidence;
	return split;
}

/**
 * Merge each orphan into whichever neighbour it is CLOSER TO IN TIME (previous wins a tie), because the pause lengths
 * already encode which phrase the word belongs to and BOTH directions occur: "...I don't belong | here" merges BACK,
 * "I | want a perfect body." merges FORWARD, and always appending backwards produces "I want to have control. I".
 *
 * A merge may push a line past `LINE_MAX_CHARS`; one extra short word reads better than a flashed row.
 */
function coalesceOrphans(input: LyricLine[]): LyricLine[] {
	if (input.length < 2) return input;
	const lines = [...input]; // local copy: the forward-merge rewrites the next entry as it goes
	const out: LyricLine[] = [];
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i]!;
		const prev = out[out.length - 1];
		const next = lines[i + 1];
		// The word's own SUNG duration, not the time to the next line: trailing silence would let a lone word followed by
		// a long pause survive as "long-lived". Read off the WORDS, because `LyricLine.start/end` are nullable.
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
 * The line being sung, else the last that has already ended (so a finished line stays lit through a gap), else 0 before
 * the first begins. Lines are assumed chronological.
 */
export function activeLineIndex(lines: LyricLine[], pos: number): number {
	if (lines.length === 0) return -1;
	let active = 0;
	for (const [i, line] of lines.entries()) {
		const b = lineBounds(line);
		if (!b) continue;
		const [start, end] = b;
		if (pos >= start && pos < end) return i;
		if (pos >= end) active = i;
		else break;
	}
	return active;
}

/** True when `pos` is inside no line of `doc` (before the first, after the last, or in a gap). A null doc has none. */
export function betweenLines(doc: Pick<LyricsDoc, 'lines'> | null, pos: number): boolean {
	return !doc?.lines.some((l) => {
		const b = lineBounds(l);
		return b !== null && pos >= b[0] && pos < b[1];
	});
}

/** The rows of `after` whose text differs from the same row of `before`, including rows `before` lacks. */
export function changedRows(before: Pick<LyricsDoc, 'lines'> | null, after: Pick<LyricsDoc, 'lines'>): Set<number> {
	const out = new Set<number>();
	for (const [i, l] of after.lines.entries()) if (before?.lines[i]?.text !== l.text) out.add(i);
	return out;
}

/** For each row of `after`, the row of `before` it stands for, so a fix that drops or adds a row is not read as
 *  a step back. Equal texts pair in order, a run between pairs pairs by position, and a row added past the end
 *  of its run counts as just after that run's last row (+0.5). */
export function rowsOf(before: Pick<LyricsDoc, 'lines'>, after: Pick<LyricsDoc, 'lines'>): number[] {
	const a = before.lines.map((l) => l.text);
	const b = after.lines.map((l) => l.text);
	// lcs(i, j): the longest in-order run of equal texts in a[i..] and b[j..], flat so no index can be undefined.
	const width = b.length + 1;
	const table = new Array<number>((a.length + 1) * width).fill(0);
	const lcs = (i: number, j: number) => table[i * width + j] ?? 0;
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			table[i * width + j] = a[i] === b[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
	const out = new Array<number>(b.length);
	let [i, j, i0, j0] = [0, 0, 0, 0];
	const pairRun = () => {
		for (let k = j0; k < j; k++) out[k] = k - j0 < i - i0 ? i0 + k - j0 : i - 0.5;
	};
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			pairRun();
			out[j] = i;
			[i0, j0] = [++i, ++j];
		} else if (lcs(i + 1, j) >= lcs(i, j + 1)) i++;
		else j++;
	}
	[i, j] = [a.length, b.length];
	pairRun();
	return out;
}

/** Index of the word within a line being sung at `pos` (the "ball" position); -1 if none/between. */
export function activeWordIndex(line: LyricLine, pos: number): number {
	for (const [i, w] of line.words.entries()) {
		if (pos >= w.start && pos < w.end) return i;
	}
	return -1;
}

/** The provenance slice the overlay needs — a Pick of the stored candidate. `vouched` is in it because the
 *  "not verified" treatment reads `isAuthoritativeText`, and a wrong-text gate's doubt rides on that field
 *  rather than on `textConfidence`: without it a doubt-band document would render as verified. */
export type LyricsProvenance = Pick<LyricsCandidate, 'textSource' | 'textConfidence' | 'timing' | 'vouched'>;

/** Should the lyrics render in the "not verified" visual treatment? */
export function isAutoTranscribed(p: LyricsProvenance | null | undefined): boolean {
	return !!p && !isAuthoritativeText(p);
}
