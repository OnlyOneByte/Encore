// Delete a song from the library entirely: a hard delete that reclaims the bytes. A song queued by
// someone else is removed along with their turn; a song playing now is SKIPPED to the next entry
// rather than refused. Admin/host gated (every guest, today). The first irreversible action in the
// product, so the ORDER below is load-bearing: meta/<id>.json is the AUTHORITATIVE record and SQLite
// is a rebuildable index over it (docs/ARCHITECTURE.md §6) — a boot rescan restores any media whose
// sidecar still exists, so the sidecar must be unlinked FIRST or a crash mid-delete resurrects the song.
//
// A SERVER op with no QueueOp — packages/shared is untouched — so it lives beside the media modules.

import type { QueueEntry, ServerEvent, Media } from '../../contract';
import type { HubDeps } from '../realtime/hub';
import { cancelJobsForMedia, type CancelJobsDeps } from '../jobs/cancel';
import { reconcileOnReady, emitNowPlaying, publishQueue } from '../realtime/player';
import type { MediaRepository } from './repository';
import { derivedRefsOf } from './retention';
import {
	metaKey,
	candidateAudioRefs,
	instrumentalKey,
	vocalsKey,
	lyricsKey,
	rawCaptionKey,
	legacyVocalsRefs,
	KNOWN_VOCALS_EXTS,
	KNOWN_CAPTION_EXTS,
	CAPTION_KINDS,
	resolveBase
} from './paths';
import { rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Everything the delete needs. `hub` is the full HubDeps the queue/playback paths already take;
 * `cancel` is the cancelJobsForMedia bag MINUS the fields this module supplies itself; `deleteFile`
 * is injected so a test can assert the ORDER of unlinks without touching a disk.
 */
export interface DeleteMediaDeps {
	hub: HubDeps;
	media: MediaRepository;
	cancel: Omit<CancelJobsDeps, 'remainingEntries' | 'mediaById' | 'broadcast'>;
	deleteFile?: (ref: string) => void;
}

export interface DeleteMediaResult {
	/** false when the media id was not in the catalog — the route answers 404. */
	deleted: boolean;
	/** Whether the deleted song was the one playing, so the caller can report a skip happened. */
	wasPlaying: boolean;
	/** How many queue entries were removed (across all singers). */
	removedEntries: number;
	/** The refs actually unlinked, IN ORDER — the mutation proof reads this to pin sidecar-first. */
	unlinked: string[];
}

/** Recursively unlink the absolute path a ref resolves to; never throws on a missing file. */
function realDeleteFile(ref: string): void {
	const { base, rest } = resolveBase(ref);
	const abs = resolve(join(base, rest));
	rmSync(abs, { force: true, recursive: true });
}

/**
 * Every derived artifact ref a media might own. Delegates to `retention.ts`'s `derivedRefsOf` — the
 * authority for everything a media STORED — rather than re-listing it, so the two lists cannot drift
 * apart again. Adds only what retention has no reason to name: ID-derived keys for a legacy scheme
 * that never stored a ref at all. Missing files are a no-op for the unlink, so naming a superset is free.
 */
function derivedRefsFor(mediaId: string, m: Media | undefined): string[] {
	const refs = new Set<string>(m ? derivedRefsOf(m) : []);
	refs.add(instrumentalKey(mediaId));
	for (const ext of KNOWN_VOCALS_EXTS) refs.add(vocalsKey(mediaId, ext));
	refs.add(lyricsKey(mediaId));
	for (const kind of CAPTION_KINDS) for (const ext of KNOWN_CAPTION_EXTS) refs.add(rawCaptionKey(mediaId, kind, ext));
	if (m?.instrumentalRef) {
		for (const r of legacyVocalsRefs(m.instrumentalRef)) refs.add(r);
	}
	return [...refs];
}

/**
 * Delete a media and everything derived from it, in the load-bearing order documented above. Returns a
 * summary the route turns into a response and the test asserts on. Idempotent for a media absent from
 * the runtime catalog (returns deleted:false); the file unlinks are ENOENT-tolerant.
 */
export function deleteMediaEntirely(mediaId: string, deps: DeleteMediaDeps): DeleteMediaResult {
	const { hub, media } = deps;
	const del = deps.deleteFile ?? realDeleteFile;
	const m = hub.mediaById.get(mediaId);

	if (!m) {
		return { deleted: false, wasPlaying: false, removedEntries: 0, unlinked: [] };
	}

	// 1. cancel any in-flight process. Empty remainingEntries → cancel unconditionally, since every
	// referencing entry is about to be removed anyway; cancelJobsForMedia is a no-op if nothing is live.
	const cancelDeps: CancelJobsDeps = { ...deps.cancel, remainingEntries: [] };
	cancelJobsForMedia(mediaId, cancelDeps);

	// 2. remove every queue entry pointing at this media — no FK cascade (schema.ts), so rows must be
	// deleted explicitly. If the PLAYING entry is among them, currentEntryId goes DANGLING and
	// reconcileOnReady skips to the next playable singer (or settles idle if none is ready).
	const doomed = hub.state.entries.filter((e: QueueEntry) => e.mediaId === mediaId);
	const wasPlaying = doomed.some((e: QueueEntry) => e.id === hub.state.playback.currentEntryId);
	for (const e of doomed) hub.state.applyQueueOp({ op: 'remove', id: e.id });
	if (wasPlaying) reconcileOnReady(hub);
	// A non-playing delete still mutates the queue (who plays next can change) but applyQueueOp
	// publishes nothing on its own, so the queue and the advertised next must be re-broadcast here too
	// — queue first, since nowplaying:changed names an entry the client should already hold.
	else {
		if (doomed.length > 0) publishQueue(hub);
		emitNowPlaying(hub);
	}

	// 3–4. unlink files: SIDECAR FIRST (see header), then audio, then derived.
	const unlinked: string[] = [];
	const unlink = (ref: string) => {
		del(ref);
		unlinked.push(ref);
	};
	unlink(metaKey(mediaId));
	// The raw audio's real extension is whatever YouTube served and is recorded nowhere (`Media` has no
	// audio field), so every candidate extension is unlinked rather than one guessed key — see
	// `candidateAudioRefs`. This is the one unrecoverable class if missed.
	for (const ref of candidateAudioRefs(mediaId)) unlink(ref);
	for (const ref of derivedRefsFor(mediaId, m)) unlink(ref);

	// 5. drop the index row + tags and the runtime hot-read catalog, so no surface resolves the song
	// after this returns.
	media.remove(mediaId);
	hub.mediaById.delete(mediaId);

	// 6. broadcast so every surface drops the song at once. media:status canceled (there is no
	// 'deleted' member) tells any surface still keyed on the live-status map the song is gone.
	const event: ServerEvent = { type: 'media:status', mediaId, status: 'canceled', pct: 0 };
	hub.publish(event);

	return { deleted: true, wasPlaying, removedEntries: doomed.length, unlinked };
}
