// The host's library actions: rename, Keep, sizes and the delete Undo window. See docs/SERVER.md#managing-the-library.

import { DELETE_UNDO_MS, readinessOf, type LibrarySizes, type Media, type QueueEntry } from '../../contract';
import type { MediaStore } from './store';
import { candidateAudioRefs } from './paths';
import { derivedRefsOf } from './retention';
import {
	readSidecar,
	readSidecarInOrder,
	sidecarFromMedia,
	updateSidecar,
	type FieldProvenance,
	type MediaSidecar
} from './sidecar';

export const NAME_MAX = 200;

/** A song the host can manage: in Library (ready) and not waiting out a delete. */
export function librarySong(
	app: { mediaById: Map<string, Media>; pendingDeletes: Pick<PendingDeletes, 'has'> },
	mediaId: string
): Media | undefined {
	const m = app.mediaById.get(mediaId);
	return m && readinessOf(m) === 'ready' && !app.pendingDeletes.has(mediaId) ? m : undefined;
}

/** Playing or still to come tonight: deleting it would cut a singer off, so the host waits for its turn. */
export function inTonightsQueue(entries: readonly QueueEntry[], mediaId: string): boolean {
	return entries.some((e) => e.mediaId === mediaId && e.status !== 'done');
}

/** The host's delete. Keep is read first, so the queue check and the start of the window run with no await
 *  between them, and an add cannot land in that gap. */
export async function requestDelete(
	app: {
		mediaById: Map<string, Media>;
		pendingDeletes: Pick<PendingDeletes, 'has' | 'schedule'>;
		state: { entries: readonly QueueEntry[] };
	},
	mediaId: string,
	// In order behind the song's queued writes, so a Keep tapped a moment ago is seen.
	isKept: (mediaId: string) => Promise<boolean> = async (id) => (await readSidecarInOrder(id))?.library.keep === true
): Promise<{ refused: 'unknown' | 'kept' | 'queued' } | { media: Media }> {
	if (!librarySong(app, mediaId)) return { refused: 'unknown' };
	const kept = await isKept(mediaId);
	const m = librarySong(app, mediaId);
	if (!m) return { refused: 'unknown' };
	if (inTonightsQueue(app.state.entries, mediaId)) return { refused: 'queued' };
	if (kept) return { refused: 'kept' };
	app.pendingDeletes.schedule(mediaId);
	return { media: m };
}

/** Writes the sidecar FIRST with `by: 'manual'`, so the upsert's own sidecar merge keeps the name. */
export async function renameSong(
	m: Media,
	name: { title: string; artist: string | null },
	upsert: (m: Media) => void
): Promise<void> {
	const manual: FieldProvenance = { by: 'manual', confidence: 'high' };
	await updateSidecar(m.id, (prev) => {
		const side = prev ?? sidecarFromMedia(m, Date.now());
		side.canonical = { ...side.canonical, title: name.title, artist: name.artist, artistCredit: name.artist };
		side.provenance = { ...side.provenance, title: manual, artist: manual };
		return side;
	});
	m.title = name.title;
	m.titleCanonical = name.title;
	m.artistCanonical = name.artist ?? undefined;
	m.artistCredit = name.artist ?? undefined;
	m.annotation = { source: 'manual', confidence: 'high' };
	upsert(m);
}

/** False when the song has no sidecar to record it in. */
export async function setKeep(mediaId: string, keep: boolean): Promise<boolean> {
	const side = await updateSidecar(mediaId, (s) => {
		if (!s) return null;
		if (keep) s.library.keep = true;
		else delete s.library.keep;
		return s;
	});
	return side !== null;
}

/** A whole library fits in one bulk call; a body past this is refused rather than looped over. */
export const BULK_MAX = 5_000;

export type BulkAction = 'keep' | 'unkeep' | 'delete' | 'undo' | 'remake';
export type BulkSkip = { mediaId: string; reason: 'unknown' | 'kept' | 'queued' | 'gone' };

/** One action over a selection, song by song through the same paths the single-song routes use, so a bulk
 *  Delete refuses a kept or queued song exactly as a single one does. */
export async function bulkManage(
	app: {
		mediaById: Map<string, Media>;
		pendingDeletes: Pick<PendingDeletes, 'has' | 'schedule' | 'undo'>;
		state: { entries: readonly QueueEntry[] };
	},
	action: BulkAction,
	mediaIds: readonly string[],
	/** Make it again for the sound (`requestRemake`); only the `remake` action calls it. */
	remake: (m: Media) => void = () => {}
): Promise<{ done: string[]; skipped: BulkSkip[]; libraryFile: boolean }> {
	const done: string[] = [];
	const skipped: BulkSkip[] = [];
	let libraryFile = false;
	for (const mediaId of new Set(mediaIds)) {
		if (action === 'undo') {
			if (app.pendingDeletes.undo(mediaId)) done.push(mediaId);
			else skipped.push({ mediaId, reason: 'gone' });
		} else if (action === 'delete') {
			const result = await requestDelete(app, mediaId);
			if ('refused' in result) skipped.push({ mediaId, reason: result.refused });
			else {
				done.push(mediaId);
				if (result.media.source === 'local') libraryFile = true;
			}
		} else if (action === 'remake') {
			const m = librarySong(app, mediaId);
			if (m) {
				remake(m);
				done.push(mediaId);
			} else skipped.push({ mediaId, reason: 'unknown' });
		} else if (librarySong(app, mediaId) && (await setKeep(mediaId, action === 'keep'))) done.push(mediaId);
		else skipped.push({ mediaId, reason: 'unknown' });
	}
	return { done, skipped, libraryFile };
}

/** Every file a delete would free, sized by the store, so an object store reports its own bytes. */
export async function songBytes(m: Media, store: Pick<MediaStore, 'size'>): Promise<number> {
	const refs = new Set([...derivedRefsOf(m), ...candidateAudioRefs(m.id)]);
	const sizes = await Promise.all([...refs].map((ref) => store.size?.(ref) ?? null));
	return sizes.reduce<number>((n, s) => n + (s ?? 0), 0);
}

export async function librarySizes(
	ready: Media[],
	store: Pick<MediaStore, 'size'>,
	capBytes: number | null,
	read: (id: string) => Promise<MediaSidecar | null> = readSidecar
): Promise<LibrarySizes> {
	const out: LibrarySizes = { songs: {}, totalBytes: 0, keptBytes: 0, capBytes };
	await Promise.all(
		ready.map(async (m) => {
			const [bytes, side] = await Promise.all([songBytes(m, store), read(m.id)]);
			const kept = side?.library.keep === true;
			out.songs[m.id] = { bytes, plays: side?.library.playCount ?? 0, kept };
			out.totalBytes += bytes;
			if (kept) out.keptBytes += bytes;
		})
	);
	return out;
}

// A little past the phone's toast, so an Undo tapped as the toast closes still lands.
const UNDO_GRACE_MS = 2_000;

/** The delete at the end of the Undo window. Keep is read again behind the song's queued writes, because a Keep
 *  that passed its route check just before the delete started can land inside the window: then the song stays. */
export async function finishDelete(
	mediaId: string,
	deps: { remove: (mediaId: string) => void; restore: (mediaId: string) => void },
	isKept: (mediaId: string) => Promise<boolean> = async (id) => (await readSidecarInOrder(id))?.library.keep === true
): Promise<void> {
	// Keep this step synchronous after the await: a queued Keep must not run between the check and the unlink.
	if (await isKept(mediaId)) deps.restore(mediaId);
	else deps.remove(mediaId);
}

/** Deletes wait out the Undo window here; `flush` runs them at shutdown. */
export class PendingDeletes {
	#timers = new Map<string, ReturnType<typeof setTimeout>>();
	// Fired but not done: the song still reads as pending until its delete settles.
	#finishing = new Map<string, Promise<void>>();
	#run: (mediaId: string) => unknown;
	#ms: number;

	/** `run` may return a promise; `flush` waits for it. */
	constructor(run: (mediaId: string) => unknown, ms = DELETE_UNDO_MS + UNDO_GRACE_MS) {
		this.#run = run;
		this.#ms = ms;
	}

	has(mediaId: string): boolean {
		return this.#timers.has(mediaId) || this.#finishing.has(mediaId);
	}

	schedule(mediaId: string): void {
		if (this.has(mediaId)) return;
		this.#timers.set(
			mediaId,
			setTimeout(() => this.#fire(mediaId), this.#ms)
		);
	}

	/** False when the window has already closed. */
	undo(mediaId: string): boolean {
		const timer = this.#timers.get(mediaId);
		if (!timer) return false;
		clearTimeout(timer);
		this.#timers.delete(mediaId);
		return true;
	}

	/** Runs every waiting delete and waits for those and any already running, up to `limitMs`.
	 *  Resolves with the ids still unfinished then, so shutdown can log them. */
	async flush(limitMs = Infinity): Promise<string[]> {
		for (const [mediaId, timer] of [...this.#timers]) {
			clearTimeout(timer);
			void this.#fire(mediaId);
		}
		const all = Promise.all(this.#finishing.values());
		let limit: ReturnType<typeof setTimeout> | undefined;
		await (Number.isFinite(limitMs) ? Promise.race([all, new Promise((r) => (limit = setTimeout(r, limitMs)))]) : all);
		clearTimeout(limit);
		return [...this.#finishing.keys()];
	}

	#fire(mediaId: string): Promise<void> {
		this.#timers.delete(mediaId);
		const done = (async () => {
			try {
				await this.#run(mediaId);
			} catch (err) {
				console.warn(`[core] library: delete of ${mediaId} failed:`, err);
			}
		})().finally(() => this.#finishing.delete(mediaId));
		// Set before `finally` can run: it is always a later microtask.
		this.#finishing.set(mediaId, done);
		return done;
	}
}
