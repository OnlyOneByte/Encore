// A hard delete that reclaims the bytes. A song queued by someone else loses their turn with it; a song
// playing now is SKIPPED rather than refused. THE ORDER BELOW IS LOAD-BEARING: meta/<id>.json is the
// AUTHORITATIVE record and SQLite only indexes it, so a boot rescan restores any media whose sidecar
// still exists — the sidecar MUST be unlinked FIRST or a crash mid-delete resurrects the song.

import type { QueueEntry, ServerEvent, Media } from '../../contract';
import type { HubDeps } from '../realtime/hub';
import { cancelJobsForMedia, type CancelJobsDeps } from '../jobs/cancel';
import { reconcileOnReady, emitNowPlaying, publishQueue } from '../realtime/player';
import type { MediaRepository } from './repository';
import { derivedRefsOf, editRefsOnDisk } from './retention';
import { queueSidecarTask } from './sidecar';
import {
	metaKey,
	candidateAudioRefs,
	instrumentalKey,
	vocalsKey,
	guideMixKey,
	lyricsKey,
	rawCaptionKey,
	legacyVocalsRefs,
	KNOWN_VOCALS_EXTS,
	KNOWN_STEM_EXTS,
	KNOWN_CAPTION_EXTS,
	CAPTION_KINDS,
	resolveBase,
	isTaggedStemOf
} from './paths';
import { readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** `cancel` is the cancelJobsForMedia bag MINUS the fields this module supplies itself. `deleteFile` is
 *  injected so a test can assert the ORDER of unlinks without touching a disk. */
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
	/** IN ORDER — the mutation proof reads this to pin sidecar-first. */
	unlinked: string[];
}

/** Never throws on a missing file. */
function realDeleteFile(ref: string): void {
	const { base, rest } = resolveBase(ref);
	const abs = resolve(join(base, rest));
	rmSync(abs, { force: true, recursive: true });
}

/**
 * DELEGATES to `retention.ts`'s `derivedRefsOf` rather than re-listing, so the two cannot drift. Adds only
 * what retention has no reason to name: id-derived keys for a legacy scheme that stored no ref. A missing
 * file is a no-op for the unlink, so a superset is free.
 */
function derivedRefsFor(mediaId: string, m: Media | undefined): string[] {
	const refs = new Set<string>(m ? derivedRefsOf(m) : []);
	// EVERY known stem ext, not just today's default. The publish format is configurable, so a library
	// holds rows written under whatever it was at the time; assuming one ext leaves those files on disk
	// forever, unreferenced and therefore invisible to retention as well.
	for (const ext of KNOWN_STEM_EXTS) {
		refs.add(instrumentalKey(mediaId, ext));
		refs.add(vocalsKey(mediaId, ext));
		refs.add(guideMixKey(mediaId, ext));
	}
	for (const ext of KNOWN_VOCALS_EXTS) refs.add(vocalsKey(mediaId, ext));
	refs.add(lyricsKey(mediaId));
	// Every fix document by id: one Undo or Back to automatic replaced, or one an eviction kept, is named nowhere.
	for (const ref of editRefsOnDisk(mediaId)) refs.add(ref);
	for (const ref of taggedStemsOnDisk(mediaId)) refs.add(ref);
	for (const kind of CAPTION_KINDS) for (const ext of KNOWN_CAPTION_EXTS) refs.add(rawCaptionKey(mediaId, kind, ext));
	if (m?.instrumentalRef) {
		for (const r of legacyVocalsRefs(m.instrumentalRef)) refs.add(r);
	}
	return [...refs];
}

/** A re-separation's stems on disk (`<id>-<tag>-instrumental.flac`, ...): one that crashed before its swap, or
 *  before deleting what it replaced, is named nowhere. None when the folder can't be read. */
function taggedStemsOnDisk(mediaId: string): string[] {
	const { base, rest } = resolveBase('derived/stems');
	try {
		return readdirSync(resolve(join(base, rest)))
			.filter((name) => isTaggedStemOf(mediaId, name))
			.map((name) => `derived/stems/${name}`);
	} catch {
		return [];
	}
}

/** In the load-bearing order documented above. Idempotent for a media absent from the runtime catalog,
 *  and the file unlinks are ENOENT-tolerant. */
export function deleteMediaEntirely(mediaId: string, deps: DeleteMediaDeps): DeleteMediaResult {
	const { hub, media } = deps;
	const del = deps.deleteFile ?? realDeleteFile;
	const m = hub.mediaById.get(mediaId);

	if (!m) {
		return { deleted: false, wasPlaying: false, removedEntries: 0, unlinked: [] };
	}

	// Empty remainingEntries → cancel unconditionally, since every referencing entry is about to go.
	const cancelDeps: CancelJobsDeps = { ...deps.cancel, remainingEntries: [] };
	cancelJobsForMedia(mediaId, cancelDeps);

	// No FK cascade, so entry rows must be deleted explicitly. If the PLAYING entry is among them,
	// currentEntryId goes DANGLING and reconcileOnReady skips to the next playable singer.
	const doomed = hub.state.entries.filter((e: QueueEntry) => e.mediaId === mediaId);
	const wasPlaying = doomed.some((e: QueueEntry) => e.id === hub.state.playback.currentEntryId);
	for (const e of doomed) hub.state.applyQueueOp({ op: 'remove', id: e.id });
	if (wasPlaying) reconcileOnReady(hub);
	// applyQueueOp publishes nothing on its own. Queue FIRST, since nowplaying:changed names an entry the
	// client should already hold.
	else {
		if (doomed.length > 0) publishQueue(hub);
		emitNowPlaying(hub);
	}

	// SIDECAR FIRST (see header), then audio, then derived.
	const unlinked: string[] = [];
	const unlink = (ref: string) => {
		del(ref);
		unlinked.push(ref);
	};
	unlink(metaKey(mediaId));
	// A sidecar write already queued would re-create the record after this, so unlink again behind it.
	void queueSidecarTask(mediaId, async () => del(metaKey(mediaId)));
	// The raw audio's real extension is recorded NOWHERE, so every candidate is unlinked rather than one
	// guessed key. This is the one unrecoverable class if missed.
	for (const ref of candidateAudioRefs(mediaId)) unlink(ref);
	for (const ref of derivedRefsFor(mediaId, m)) unlink(ref);

	// Index row, tags and the runtime catalog, so no surface resolves the song after this returns.
	media.remove(mediaId);
	hub.mediaById.delete(mediaId);

	// `canceled` because there is no 'deleted' member: it tells any surface keyed on the live-status
	// map that the song is gone.
	const event: ServerEvent = { type: 'media:status', mediaId, status: 'canceled', pct: 0 };
	hub.publish(event);

	return { deleted: true, wasPlaying, removedEntries: doomed.length, unlinked };
}
