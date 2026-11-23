// Imported by BOTH the client's optimistic apply and the server's authoritative one: the same code on both
// ends is what makes the client's prediction unable to diverge from what the server commits.

import type { QueueEntry, EntryStatus, Media } from './types';

export type QueueOp =
	| { op: 'add'; entry: QueueEntry } // entry.id is the client-minted ULID
	| { op: 'remove'; id: string }
	| { op: 'move'; id: string; toSeq: number } // toSeq = target index into the singer's own QUEUED picks (reorderWithinSinger indexes queued entries only; a playing/terminal entry never occupies a slot), NOT a rotationSeq
	// CROSSES SINGERS: `toIdx` indexes the WHOLE queued list, which `move` cannot express, since it only
	// permutes one singer's picks among the slots that singer already holds. Both sides rewrite the stored
	// list through `moveToIndex`, so the two cannot diverge.
	| { op: 'move-to-index'; id: string; toIdx: number } // toIdx = target index into the whole QUEUED list (a playing/terminal entry keeps its slot and never occupies one)
	// OWNER ONLY, both. ABSOLUTE values, like the `key` player command, so a resend is a no-op rather than a drift.
	| { op: 'set-entry-prefs'; id: string; keyShift: number; guideLevel: number | null }
	// "Not yet": a `move-to-index` that also spends the entry's one deferral, in ONE op so the two cannot split.
	| { op: 'not-yet'; id: string; toIdx: number }
	// SAME TURN, ANOTHER SONG: "Pick another, keep your spot" for a song that could not be made. id, singer,
	// addedAt, rotationSeq and `deferred` stay, so the turn holds the place the held-slot rule kept for it. The
	// PREFS do not: `keyShift` is the NEW song's remembered key (absolute, as in `set-entry-prefs`) and the guide
	// goes back to the room default, or the new song would start in a key the singer chose for the dead one.
	| { op: 'replace-media'; id: string; mediaId: string; keyShift: number }
	// SERVER-OWNED, like `status`: the TV reported the playing song failed. Back to `queued` in the SAME slot, held.
	| { op: 'play-failed'; id: string }
	// "Try again" (OWNER ONLY): lift a held turn so its song plays next. Nothing moves: the turn's slot is already
	// earlier than anyone waiting, which is why it was held there.
	| { op: 'retry-play'; id: string }
	| { op: 'status'; id: string; status: EntryStatus };

/** A song the TV failed this many times in one turn gets no Try again: only Pick another. SHARED so the phone offers
 *  exactly what the hub accepts. */
export const MAX_PLAY_FAILURES = 2;

/** Can the singer Try again on this turn? Only a held one, and only until its song has failed `MAX_PLAY_FAILURES` times. */
export function canRetryPlay(e: Pick<QueueEntry, 'playFailed' | 'playFailures'>): boolean {
	return !!e.playFailed && (e.playFailures ?? 0) < MAX_PLAY_FAILURES;
}

export interface ClientCommand {
	clientOpId: string; // ULID — idempotency + reject routing
	op: QueueOp;
}

export interface ServerPatch {
	rev: number; // new authoritative rev AFTER applying ops
	ops: QueueOp[]; // canonical ops (server may rewrite, e.g. assign rotationSeq)
	causedBy?: string; // echoes clientOpId so the originator can clear 'pending'
	// Pruned and reseq'd, carried inline so a client adopts server `rotationSeq` in ONE message rather than
	// a second sync per mutation. Omitted on a pure re-ack, where nothing changed.
	entries?: QueueEntry[];
	// Any media `entries` references that the client may not hold yet (someone else's add).
	media?: Media[];
}

/** A NEW array sorted by `rotationSeq`, identical on client and server. An unknown id is a no-op, which is
 *  what makes replay idempotent. */
export function applyOp(entries: QueueEntry[], op: QueueOp): QueueEntry[] {
	let next: QueueEntry[];
	switch (op.op) {
		case 'add':
			// Match by id updates in place (the originator already had the optimistic row); else insert.
			next = entries.some((e) => e.id === op.entry.id)
				? entries.map((e) => (e.id === op.entry.id ? op.entry : e))
				: [...entries, op.entry];
			break;
		case 'remove':
			next = entries.filter((e) => e.id !== op.id);
			break;
		case 'move':
			next = entries.map((e) => (e.id === op.id ? { ...e, rotationSeq: op.toSeq } : e));
			break;
		case 'move-to-index':
			// A raw-seq fallback: the real path is `applyAndReseq` -> `moveToIndex`, so a direct caller here
			// gets a raw index the next renumber overwrites.
			next = entries.map((e) => (e.id === op.id ? { ...e, rotationSeq: op.toIdx } : e));
			break;
		case 'replace-media':
			// A QUEUED turn only: the playing song's media is what the TV is decoding. A new song is a new chance, so a
			// turn held for a song the TV could not play is lifted and its failure count starts again. The SAME song is not
			// a new chance: it keeps its count, so picking it again is a Try again under the same limit (the hub's rule).
			next = entries.map((e) =>
				e.id === op.id && e.status === 'queued'
					? {
							...e,
							mediaId: op.mediaId,
							keyShift: op.keyShift,
							guideLevel: null,
							playFailed: false,
							playFailures: op.mediaId === e.mediaId ? e.playFailures : 0
						}
					: e
			);
			break;
		case 'status':
			next = entries.map((e) => (e.id === op.id ? { ...e, status: op.status } : e));
			break;
		case 'play-failed':
			next = entries.map((e) =>
				e.id === op.id
					? { ...e, status: 'queued' as const, playFailed: true, playFailures: (e.playFailures ?? 0) + 1 }
					: e
			);
			break;
		case 'retry-play':
			next = entries.map((e) => (e.id === op.id ? { ...e, playFailed: false } : e));
			break;
		case 'set-entry-prefs':
			next = entries.map((e) => (e.id === op.id ? { ...e, keyShift: op.keyShift, guideLevel: op.guideLevel } : e));
			break;
		case 'not-yet':
			// Same raw-seq fallback as `move-to-index`; the real path is `applyAndReseq`.
			next = entries.map((e) => (e.id === op.id ? { ...e, rotationSeq: op.toIdx, deferred: true } : e));
			break;
	}
	return next.sort((a, b) => a.rotationSeq - b.rotationSeq);
}
