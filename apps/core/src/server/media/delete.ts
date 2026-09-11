// Delete a song from the library ENTIRELY — the destructive admin action of issue #639. The owner's
// ruling (recorded on the issue, 2026-09-07): a hard delete that reclaims the bytes; a song queued by
// someone else is deleted along with their turn; a song playing right now is SKIPPED to the next entry
// rather than refused; gated to admin/host, which is every guest today. This is the first irreversible
// action in the product, so the ORDER below is load-bearing, not incidental.
//
// WHY THE ORDER. The sidecar meta/<id>.json is the AUTHORITATIVE record and the SQLite row is a
// rebuildable index over it (media/sidecar.ts, docs/ARCHITECTURE.md): a boot rescan restores any media
// whose sidecar still exists. So the sidecar must go FIRST — delete the row first and a crash before the
// sidecar is removed resurrects the whole song on the next boot. Sequence:
//   1. cancel any in-flight cook (subprocess kill + slot free) — jobs/cancel.ts cancelJobsForMedia
//   2. remove every queue entry that points at this media (there is NO FK cascade — schema.ts — so the
//      rows must be deleted explicitly, and if the PLAYING entry is one of them the playback path skips
//      to the next singer rather than leaving a dangling current)
//   3. unlink the sidecar FIRST (kills the source of truth so a rescan cannot bring it back)
//   4. then the raw audio at EVERY extension it could be under, then every derived artifact — both
//      enumerations delegate rather than re-implement (paths.ts candidateAudioRefs, retention.ts
//      derivedRefsOf), because the hand-written versions of both had already drifted narrow
//   5. then the media row + its tags from the index
//   6. then broadcast — the queue snapshot, the advertised next, and the per-media status — so every
//      surface drops the song at once instead of one surface at a time (F3)
//
// A SERVER op with no QueueOp — packages/shared is untouched — so it lives beside the media modules.

import type { QueueEntry, ServerEvent, Media } from '@encore/shared';
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
 * Every derived artifact ref a media might own. `retention.ts`'s `derivedRefsOf` is the AUTHORITY for
 * everything a media STORED (instrumental, vocals at any historical ext, the chosen lyrics JSON, every
 * other lyrics candidate's JSON, the retained raw caption matrix) — this used to re-implement that list
 * and drifted immediately: it named `lyricsKey` + `m.lyricsRef` and stopped, so every non-chosen lyrics
 * candidate was orphaned on disk forever (F2, the same undercount an earlier change closed for retention).
 * Delegating removes the possibility of drifting again; a one-line `lyricsCandidates` patch here would
 * have closed today's symptom and left the next divergence free.
 *
 * What the delete adds on top is only what retention has no reason to name: the ID-DERIVED keys for a
 * cook that wrote under an older scheme and never stored a ref at all (retention walks live media and
 * reads their refs; the delete must name candidates for a row whose refs are missing or stale). Missing
 * files are a no-op for the unlink, so naming a superset is free.
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

	// 1. cancel any in-flight cook. Empty remainingEntries → cancel unconditionally (we are about to
	// remove every referencing entry). mediaById/broadcast omitted: settling a row about to be deleted
	// and re-announced in step 6 is pointless. cancelJobsForMedia is a no-op when nothing is live.
	const cancelDeps: CancelJobsDeps = { ...deps.cancel, remainingEntries: [] };
	cancelJobsForMedia(mediaId, cancelDeps);

	// 2. remove every queue entry pointing at this media. No FK cascade (schema.ts), so each row goes
	// through the same authoritative reducer the client remove op uses. If the PLAYING entry is among
	// them, removing it leaves currentEntryId DANGLING; reconcileOnReady then skips to the next playable
	// singer (owner ruling 1c) or settles the room idle if none is ready.
	const doomed = hub.state.entries.filter((e: QueueEntry) => e.mediaId === mediaId);
	const wasPlaying = doomed.some((e: QueueEntry) => e.id === hub.state.playback.currentEntryId);
	for (const e of doomed) hub.state.applyQueueOp({ op: 'remove', id: e.id });
	if (wasPlaying) reconcileOnReady(hub);
	// deleting a NON-playing entry still mutates the queue, so "who plays next" can change —
	// the deleted song may have been the advertised upNext, or removing it may promote a different
	// singer's entry. reconcileOnReady only fires on the wasPlaying path (a dangling current), so the
	// far more common non-playing delete published queue:removed with no nowplaying:changed and the TV
	// kept naming the deleted song. Re-derive and re-broadcast the advertised next here too;
	// emitNowPlaying is idempotent, so the `else` only avoids the double emit reconcileOnReady already does.
	//
	// F3: and re-broadcast the QUEUE ITSELF, which neither of them did. applyQueueOp publishes
	// nothing, and on this branch the only broadcast was step 6's `media:status canceled`, which no
	// client turns into a queue mutation — so every phone and the TV kept the removed turn, and the
	// singer whose turn it was still saw themselves queued. `publishQueue` is player.ts's own, made
	// exported rather than copied: it already decides the shape a server-side queue broadcast has
	// (`ops: []` with the authoritative entries + mediaFor inline, so the client adopts the snapshot and
	// re-applies its pending ops), and a second hand-written copy here would be this repo's fourth
	// beside hub.ts, player.ts and singers/leave.ts — the same two-answers-to-one-question shape that
	// produced F1 and F2. Guarded on `doomed.length` because a delete that removed no entries did not
	// mutate the queue and must not bump every client through a no-op resync. Queue first, then
	// nowplaying, the order every other mutation path uses: the upNext in `nowplaying:changed` names an
	// entry, so the client should already hold the entry list it names — reconcileOnReady's own branches
	// publish the queue before their final emitNowPlaying too.
	else {
		if (doomed.length > 0) publishQueue(hub);
		emitNowPlaying(hub);
	}

	// 3–4. unlink files: SIDECAR FIRST, then audio, then derived. The sidecar is the source of truth (a
	// rescan rebuilds the row FROM it), so it dies first: a crash after this can orphan bytes
	// (reclaimable) but can NEVER resurrect the song.
	const unlinked: string[] = [];
	const unlink = (ref: string) => {
		del(ref);
		unlinked.push(ref);
	};
	unlink(metaKey(mediaId)); // 3. the authoritative record — FIRST
	// 4a. the one unrecoverable class. EXT-BLIND (F1): this was `unlink(audioKey(mediaId))`, and
	// `audioKey`'s default ext is `wav` — the LEGACY mislabelled name. The worker downloads to
	// `audio/<id>.%(ext)s` and discovers the real name with a `<id>.*` glob because the extension is
	// whatever YouTube served, so for every song cooked since 2981662 the file is `audio/<id>.m4a` or
	// `.webm` and the single unlink named a path that does not exist. The bytes then survived
	// PERMANENTLY, not until the next sweep: the sidecar and the row are gone by the time this returns,
	// retention is barred from `audio/` by design, and there is no orphan-audio pass in the boot chain —
	// so nothing can ever enumerate that media again. Nothing recorded the real name either (`Media` has
	// no audio field; the sidecar's `artifacts.audio` is only ever `prev ?? null`), which is why this
	// names candidates rather than reading one: see `candidateAudioRefs`.
	for (const ref of candidateAudioRefs(mediaId)) unlink(ref);
	for (const ref of derivedRefsFor(mediaId, m)) unlink(ref); // 4b. regenerable artifacts

	// 5. drop the index row + its tags, and the runtime hot-read catalog, so no surface resolves the
	// song after this returns.
	media.remove(mediaId);
	hub.mediaById.delete(mediaId);

	// 6. broadcast — every surface drops the song at once. media:status canceled (there is no 'deleted'
	// member and packages/shared is untouched here) tells any surface still
	// keyed on the live-status map (a search row, a stale cooking chip) that the song is gone.
	const event: ServerEvent = { type: 'media:status', mediaId, status: 'canceled', pct: 0 };
	hub.publish(event);

	return { deleted: true, wasPlaying, removedEntries: doomed.length, unlinked };
}
