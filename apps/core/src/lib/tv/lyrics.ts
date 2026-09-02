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
	return { language: typeof r.language === 'string' ? r.language : null, lines, words: flat };
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
