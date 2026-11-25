// The host's lyrics fixes as data: corrected words, Undo and Back to automatic. See docs/SERVER.md#lyrics-fixes.

import type { Job, Media } from '../../contract';
import { clampLyricsOffsetMs, resolveLyricsRef } from '../../contract';
import { editLyricsRef, retimeLyrics, type ProcessDeps } from './process';
import { readSidecar, updateSidecar } from '../media/sidecar';

/** One earlier lyrics state, as Undo restores it. Kept only in the sidecar. */
export interface LyricsEditSnapshot {
	rev: number;
	/** When this state was replaced. */
	at: number;
	ref?: string;
	text?: string;
}

export const LYRICS_HISTORY_MAX = 20;
export const LYRICS_EDIT_MAX_LINES = 400;
export const LYRICS_EDIT_MAX_LINE_CHARS = 300;

export type LyricsEditRefusal =
	| 'unknown-media'
	| 'stale' // the save named an older rev: another host changed the song first
	| 'not-processed' // new words need the vocals stem to be timed against
	| 'no-text'
	| 'bad-lines'
	| 'nothing-to-undo';

export interface LyricsEditResult {
	rev: number;
	/** The re-time this change started, when the words need timing again. */
	job?: Job;
	/** The state this change replaced, for the caller to keep; absent when nothing changed. */
	replaced?: LyricsEditSnapshot;
}

type EditDeps = Pick<ProcessDeps, 'jobs' | 'mediaById' | 'state' | 'now'>;

/** `lines` from an untrusted body, cleaned as one-line text, or why not. Blank lines are dropped. */
export function parseEditLines(raw: unknown): string[] | 'bad-lines' | 'no-text' {
	if (!Array.isArray(raw) || raw.length > LYRICS_EDIT_MAX_LINES) return 'bad-lines';
	const lines: string[] = [];
	for (const line of raw) {
		const text = line && typeof line === 'object' ? (line as { text?: unknown }).text : undefined;
		if (typeof text !== 'string' || text.length > LYRICS_EDIT_MAX_LINE_CHARS) return 'bad-lines';
		// eslint-disable-next-line no-control-regex -- a control character or line break would split or hide a line
		const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
		if (clean) lines.push(clean);
	}
	return lines.length ? lines : 'no-text';
}

export function snapshotOf(m: Media, at: number): LyricsEditSnapshot {
	return {
		rev: m.lyricsEditRev ?? 0,
		at,
		...(m.lyricsOverrideRef ? { ref: m.lyricsOverrideRef } : {}),
		...(m.lyricsOverrideText ? { text: m.lyricsOverrideText } : {})
	};
}

/** `history` with `snap` on the end, oldest dropped past the cap. */
export function pushHistory(history: readonly LyricsEditSnapshot[] | undefined, snap: LyricsEditSnapshot) {
	return [...(history ?? []), snap].slice(-LYRICS_HISTORY_MAX);
}

/** The newest kept state, which Undo would restore. */
export async function newestKept(mediaId: string): Promise<LyricsEditSnapshot | undefined> {
	return (await readSidecar(mediaId))?.artifacts.lyricsEditHistory?.at(-1);
}

/** How many states Undo can still go back through. */
export async function keptCount(mediaId: string): Promise<number> {
	return (await readSidecar(mediaId))?.artifacts.lyricsEditHistory?.length ?? 0;
}

/** Keep `replaced` for Undo. Call in the same tick as the change, after the media row is persisted. */
export function keepReplaced(mediaId: string, replaced: LyricsEditSnapshot): Promise<unknown> {
	return updateSidecar(mediaId, (s) =>
		s
			? { ...s, artifacts: { ...s.artifacts, lyricsEditHistory: pushHistory(s.artifacts.lyricsEditHistory, replaced) } }
			: null
	);
}

/** Forget `restored`, which Undo just put back. Call in the same tick as the undo. */
export function dropRestored(mediaId: string, restored: LyricsEditSnapshot): Promise<unknown> {
	return updateSidecar(mediaId, (s) => {
		const history = s?.artifacts.lyricsEditHistory ?? [];
		const at = history.findLastIndex((h) => h.rev === restored.rev && h.at === restored.at);
		if (!s || at < 0) return null;
		return { ...s, artifacts: { ...s.artifacts, lyricsEditHistory: history.toSpliced(at, 1) } };
	});
}

/** Show the words the new state names: at once when that document exists, else from a re-time. */
function settleWords(m: Media, deps: EditDeps, singerId?: string): Job | undefined {
	const candidates = m.lyricsCandidates ?? [];
	if (m.lyricsOverrideRef && candidates.some((c) => c.ref === m.lyricsOverrideRef)) {
		m.lyricsRef = m.lyricsOverrideRef;
		return undefined;
	}
	const ranked = m.lyricsOverrideRef ? undefined : resolveLyricsRef(candidates, undefined);
	if (ranked) {
		m.lyricsRef = ranked;
		return undefined;
	}
	// The pinned words were evicted, or nothing automatic is stored: time them again when there is a stem.
	return m.vocalsRef ? retimeLyrics(m, deps, singerId) : undefined;
}

/** Save the host's words. Words that differ from the pinned ones are re-timed under a new ref. */
export function requestLyricsEdit(
	mediaId: string,
	change: { rev: number; lines: string[] },
	deps: EditDeps,
	singerId?: string
): LyricsEditResult | LyricsEditRefusal {
	const m = deps.mediaById.get(mediaId);
	if (!m) return 'unknown-media';
	const rev = m.lyricsEditRev ?? 0;
	if (change.rev !== rev) return 'stale';
	const text = change.lines.join('\n');
	if (text === m.lyricsOverrideText) return { rev };
	if (!m.vocalsRef) return 'not-processed';

	const replaced = snapshotOf(m, deps.now());
	m.lyricsEditRev = rev + 1;
	m.lyricsOverrideRef = editLyricsRef(mediaId, rev + 1);
	m.lyricsOverrideText = text;
	return { rev: rev + 1, replaced, job: retimeLyrics(m, deps, singerId) };
}

/** Restore `previous`, the newest kept state. Its words come back at once when their document is still stored. */
export function requestLyricsUndo(
	mediaId: string,
	rev: number,
	previous: LyricsEditSnapshot | undefined,
	deps: EditDeps,
	singerId?: string
): LyricsEditResult | LyricsEditRefusal {
	const m = deps.mediaById.get(mediaId);
	if (!m) return 'unknown-media';
	if (rev !== (m.lyricsEditRev ?? 0)) return 'stale';
	if (!previous) return 'nothing-to-undo';
	m.lyricsEditRev = rev + 1;
	m.lyricsOverrideRef = previous.ref;
	m.lyricsOverrideText = previous.text;
	return { rev: rev + 1, job: settleWords(m, deps, singerId) };
}

/** Drop the host's words and pick, and show the ranked choice. The state it leaves is kept for Undo. */
export function requestLyricsAuto(
	mediaId: string,
	rev: number,
	deps: EditDeps,
	singerId?: string
): LyricsEditResult | LyricsEditRefusal {
	const m = deps.mediaById.get(mediaId);
	if (!m) return 'unknown-media';
	if (rev !== (m.lyricsEditRev ?? 0)) return 'stale';
	const replaced = snapshotOf(m, deps.now());
	m.lyricsEditRev = rev + 1;
	m.lyricsOverrideRef = undefined;
	m.lyricsOverrideText = undefined;
	return { rev: rev + 1, replaced, job: settleWords(m, deps, singerId) };
}

/** Set the host's whole-song nudge. It applies at render, so there is no worker, no rev and no Undo entry:
 *  the host taps it back. @returns the nudge as stored. */
export function requestLyricsOffset(
	mediaId: string,
	offsetMs: number,
	deps: Pick<EditDeps, 'mediaById'>
): number | 'unknown-media' {
	const m = deps.mediaById.get(mediaId);
	if (!m) return 'unknown-media';
	m.lyricsOffsetMs = clampLyricsOffsetMs(offsetMs);
	return m.lyricsOffsetMs;
}
