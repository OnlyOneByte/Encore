// The host's library actions: rename, Keep, sizes and the delete Undo window. See docs/SERVER.md#managing-the-library.

import { DELETE_UNDO_MS, readinessOf, type LibrarySizes, type Media, type QueueEntry } from '../../contract';
import type { MediaStore } from './store';
import { candidateAudioRefs } from './paths';
import { derivedRefsOf } from './retention';
import { readSidecar, sidecarFromMedia, writeSidecar, type FieldProvenance, type MediaSidecar } from './sidecar';

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

/** Writes the sidecar FIRST with `by: 'manual'`, so the upsert's own sidecar merge keeps the name. */
export async function renameSong(
	m: Media,
	name: { title: string; artist: string | null },
	upsert: (m: Media) => void
): Promise<void> {
	const side = (await readSidecar(m.id)) ?? sidecarFromMedia(m, Date.now());
	const manual: FieldProvenance = { by: 'manual', confidence: 'high' };
	side.canonical = { ...side.canonical, title: name.title, artist: name.artist, artistCredit: name.artist };
	side.provenance = { ...side.provenance, title: manual, artist: manual };
	await writeSidecar(side);
	m.title = name.title;
	m.titleCanonical = name.title;
	m.artistCanonical = name.artist ?? undefined;
	m.artistCredit = name.artist ?? undefined;
	m.annotation = { source: 'manual', confidence: 'high' };
	upsert(m);
}

/** False when the song has no sidecar to record it in. */
export async function setKeep(mediaId: string, keep: boolean): Promise<boolean> {
	const side = await readSidecar(mediaId);
	if (!side) return false;
	if (keep) side.library.keep = true;
	else delete side.library.keep;
	await writeSidecar(side);
	return true;
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

/** Deletes wait out the Undo window here; `flush` runs them at shutdown. */
export class PendingDeletes {
	#timers = new Map<string, ReturnType<typeof setTimeout>>();
	#run: (mediaId: string) => void;
	#ms: number;

	constructor(run: (mediaId: string) => void, ms = DELETE_UNDO_MS + UNDO_GRACE_MS) {
		this.#run = run;
		this.#ms = ms;
	}

	has(mediaId: string): boolean {
		return this.#timers.has(mediaId);
	}

	schedule(mediaId: string): void {
		if (this.#timers.has(mediaId)) return;
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

	flush(): void {
		for (const [mediaId, timer] of [...this.#timers]) {
			clearTimeout(timer);
			this.#fire(mediaId);
		}
	}

	#fire(mediaId: string): void {
		this.#timers.delete(mediaId);
		try {
			this.#run(mediaId);
		} catch (err) {
			console.warn(`[core] library: delete of ${mediaId} failed:`, err);
		}
	}
}
