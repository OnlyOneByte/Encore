// THE DEAD-TURN READER. A DEAD TURN is a queued entry whose song can never become singable: the rotation
// holds its slot and skips it on every pass, forever (`process-and-queue.ts` names the hazard, and
// `nextPlayable` is what does the skipping). PURE policy plus injected IO — the shape `gate-reconcile.ts`
// and `leases.ts` use — so the rule tests with no DB, no clock and no sockets.
//
// IT IS A READER, NEVER A STATE, and that is the load-bearing decision: nothing in this module writes, and
// no consumer of it may. Every alternative is closed by a rule already written in this tree:
//  · `media.stemStatus` has no 'failed' member BY DESIGN — contract/process/readiness.ts: "a dead process
//    settles the status back to un-processed, so the honest answer is `unacquired`. Failure is a LIVE
//    event". A mark there would un-reprocess a song forever.
//  · `EntryStatus` is 'queued' | 'playing' | 'done', `isTerminal(e)` is `status === 'done'`, and
//    `applyAndReseq` PRUNES terminal entries on the very next op. So a new 'dead' status is both a parallel
//    mechanism (wire union, Drizzle enum, isTerminal, applyAndReseq, nextPlayable, removableOnLeave, the
//    client optimistic store, every `status === 'queued'` filter) AND a race against the add that the
//    offline-tolerant `QueueStore` re-sends on resync.
//  · Cancelling the turn is the rejected rollback, for that same resend: on a transient refusal it would
//    DELETE a turn the guest genuinely asked for.
// What no client could ever see is the "no live job can still make it ready" half: `queue:sync` carries
// entries/singers/media/online/away/settings and no job or failure field at all, and `media:status` is
// live-only and in-memory. The durable witness already exists — the `jobs` ledger — and this is its reader.
//
// THE PREDICATE, ledger-only. A queued entry is DEAD iff
//     entry.status === 'queued'
//     AND !readyToSing(media)                   // a required gate is still open
//     AND no OUTSTANDING job for that media     // nothing left that could close it
// Neither term is restated here: `readyToSing` is the shared gate table, and the outstanding test is
// `JobRepository.findOutstandingForMedia`'s own rule, injected as `hasOutstandingJob` (its set-valued twin
// `mediaWithOutstandingJob` is what the periodic caller passes, for one select instead of three per media).
//
// WHY IT CANNOT LIBEL A SEPARATION THAT IS GENUINELY IN FLIGHT — two independent protections, both from
// `requestProcess` (process.ts), which sets `stemStatus = 'queued'` AND enqueues `fetch`/`stems` in ONE
// synchronous block: such a media has a non-terminal job, so the third term fails, and it reads as
// `processing` rather than unacquired. Either term alone protects it; both do.
//
// LEDGER-ONLY RATHER THAN READING `stem_status`, deliberately. `settleStemsGate` resets that column to
// 'none' ("nothing was separated, so it is a fresh candidate"), so the media row ERASES the failure by
// design; and `reportTerminalFailure`'s `persist` sink is OPTIONAL in the type, so a column-based predicate
// is hostage to every terminal path remembering to pass one — which one did not (see the reaper's `onFailed`
// in app.ts). The ledger is immune to both.
//
// PREDICATES THAT LOOK RIGHT ON A SNAPSHOT AND ARE NOT. Measured read-only on the owner's library copy on
// 2026-10-15, where this predicate matches ~100 queued turns over ~60 songs. THE EXACT COUNTS ARE LEFT
// ROUND ON PURPOSE: that copy moves every time this work drives a browser against it, and successive
// honest measurements of the same population over two days read 89/50, then 101/57, then 101/61. A comment
// pinned to one of those is a comment that is false by the next afternoon, so the STRUCTURAL facts carry
// the argument instead — each of them has held across every measurement:
//  · `instrumental_ref IS NULL` alone matches exactly the SAME entries as the full predicate — a symmetric
//    difference of 0 in both directions. That agreement is a property of the SNAPSHOT, which holds ZERO
//    non-terminal rows in the whole `jobs` table and no queued-entry media mid-process, not of the
//    predicate: ship the loose one and the first guest who taps Sing during a pass has their honest
//    "Making karaoke…" called dead.
//  · 95% of that ledger's 4,803 rows are UNSERVABLE KILLS — `status='failed'`, `attempts=0`, error "no
//    connected worker advertised capability … within 120s". Every shortcut below trips over that fact.
// ALSO REJECTED, each for a measured reason:
//  · `attempts` — the unservable kills carry attempts=0, indistinguishable from never-tried.
//  · `lease_expires_at` — NULL on every one of them: they died in `#sweepUnservable`, never in the reaper's
//    `sweep`, so the column that would record "a worker once held this" was never written.
//  · AGE, and it is rejected for very nearly the OPPOSITE of the reason once written here. That reason was
//    "observed legitimate finished durations reach 898 s for a fetch and ~20 h for an align" — but both of
//    those rows ARE unservable kills, i.e. members of the population the predicate exists to find, not
//    legitimate work. On this copy EVERY row whose `created_at → updated_at` lifetime exceeds 91 s is an
//    unservable kill; work that genuinely finished tops out at 90.2 s (fetch), 80.2 s (stems) and 25.8 s
//    (align), and at 31.2 s in `job_attempts` by `started_at → finished_at`. So age here is not weak, it is
//    CONFOUNDED: it correlates with death because the long rows are the dead ones, which means no threshold
//    can be fitted on this data without fitting it to the answer. Two reasons survive that. First, a LIVE
//    job has no finish time at all, so an age test is unavoidably a comparison against a CONSTANT — exactly
//    the constant `DeadTurnWatch`'s two-pass rule needs none of. Second, that constant cannot be calibrated
//    from a box which never ran a long separation: `onRevoked`'s own comment in app.ts is written for a
//    worker "40 minutes into a separation", over 26× the longest honest run measured here, and such a run
//    would sit inside any threshold these numbers suggest.
//
// ONE WINDOW IS JUDGEMENT RATHER THAN MEASUREMENT, and it is named here because it is where this reader
// could be wrong: core dying between `jobs.complete(fetch)` (terminal 'ready') and the `followUps` enqueue
// of `stems` leaves a terminal fetch, no stems job and an open gate, which this reader calls dead. It
// genuinely IS dead — nothing re-enqueues it, and `reconcileStrandedGates` settles that media at the next
// boot without re-enqueuing — but nobody has reproduced it. It is safe today only because `jobs.complete`
// and the follow-up enqueue sit in ONE synchronous block in `WorkerHub`'s `#onCompleted`; moving that work
// off-thread or splitting the transaction gives this reader a real false-positive window.

import type { Media, QueueEntry } from '../../contract';
import { readyToSing } from '../../contract';

/** One queued turn the rotation can never play. Per ENTRY, not per media: a media can hold many turns (one
 *  holds ten on the owner's copy), and the holder is what a notice or an operator line needs to name. */
export interface DeadTurn {
	entryId: string;
	mediaId: string;
	/** The singer holding the turn — the one party who asked for this song and will never hear it. */
	singerId: string;
}

/**
 * The dead turns among `entries`, in the order given (rotation order at the caller).
 *
 * SCOPED BY THE ENTRIES, never by the catalog, and that is the perf shape as much as the semantics: the
 * question is only ever asked about media a QUEUED ENTRY points at (~300 entries over ~80 media on the
 * owner's copy), where the catalog is far larger and a dead media nobody queued costs nobody a turn.
 */
/* ONE ASYMMETRY WITH THE PHONE, recorded because the two predicates are deliberately not identical and a
 * reader will otherwise assume they are. THIS function's second term is "any required gate is open"
 * (`!readyToSing`). The phone's `queueCardKind` only reaches its `stalled` arm for the STEMS gate: a media whose
 * stems are ready but whose LYRICS gate is open with no `align` job reads `processing` through
 * `isProcessing`/`readinessOf`, so the card draws "Making karaoke…" and offers no retry — and tapping the song
 * again does not help either, because `processState` sees `isProcessed(media)` and `requestProcess` returns null.
 * So this census can count a turn the phone gives no way out of.
 * MEASURED BEFORE WRITING THIS: that subpopulation is EMPTY on the owner's copy — 0 of the 101 dead turns have
 * `instrumental_ref` set, every one is `stem_status='none'`. So the asymmetry is latent, not live, which is why
 * it is recorded here rather than closed: closing it means giving the lyrics gate its own retry path, which is
 * a product decision about what "re-time the words" should offer on a row the guest did not open.
 * The LIVE case is already covered: when a broadcast carries `unservable`, `queueCardKind` returns `stalled`
 * regardless of which gate it was — only the no-live-status path (a reload) falls through. */
export function deadTurns(
	entries: readonly QueueEntry[],
	mediaById: ReadonlyMap<string, Media>,
	hasOutstandingJob: (mediaId: string) => boolean
): DeadTurn[] {
	const dead: DeadTurn[] = [];
	for (const entry of entries) {
		// 'playing' is being sung right now and 'done' is pruned on the next op, so neither is a turn the
		// rotation is still holding. Written as the positive test rather than `!isTerminal(e)`, which admits
		// 'playing': the claim is about what the rotation WILL play.
		if (entry.status !== 'queued') continue;
		const media = mediaById.get(entry.mediaId);
		// A media missing from the catalog cannot be ASKED whether it is singable, so it is not provably
		// dead — the same reasoning `queueCardKind`'s no-media arm gives. The hub validates every add against
		// this map, so this is a torn-state case rather than a normal one.
		if (!media) continue;
		if (readyToSing(media)) continue;
		if (hasOutstandingJob(entry.mediaId)) continue;
		dead.push({ entryId: entry.id, mediaId: entry.mediaId, singerId: entry.singerId });
	}
	return dead;
}

/**
 * The memory a PERIODIC caller needs: two sets, no clock, no constant.
 *
 * TWO CONSECUTIVE PASSES BEFORE A MEDIA COUNTS AS NEWLY DEAD. `processAndQueue` starts the job before it
 * adds the turn, so Sing leaves no window where the entry exists and no job does. The grace stays because it
 * is cheap and covers a tab still running the old queue-first code. Requiring the same media on two
 * consecutive passes closes that with no number to defend, which is the `#unservableSince` discipline in
 * worker-hub minus its TTL. (A server-side `addedAt` grace would also be sound, since the hub re-stamps
 * `addedAt` from the room's own clock at `nextAddedAt()`. It needs a constant; this does not. The same
 * grace on the CLIENT would not be sound at all: there `addedAt` is a server stamp compared against the
 * device's `Date.now()`.)
 *
 * ANNOUNCE-ONCE, for the reason the membership sweep gives in server.ts — "Comparing against the last
 * broadcast keeps a quiet room's sweep silent." Without it a 3 s tick re-announces the same turns every 3 s
 * forever. PRUNING IS ONE RULE, not three hooks: a media absent from the current pass leaves both sets,
 * which covers every way it can stop being dead (a retry landing, the entry removed, the media deleted) and
 * lets a turn that dies AGAIN after a retry announce again.
 *
 * THE FIRST PASS IS ADOPTED SILENTLY, and that is a deliberate asymmetry rather than an oversight. A turn
 * already dead when this process starts is by definition pre-existing: announcing it would print the whole
 * standing population at boot (~100 turns on the owner's copy) as if it had just happened. The standing
 * population is a CENSUS, reported once at boot by the caller; this watch answers "what died while we were
 * watching".
 *
 * STEPPED ON EVERY PASS, INCLUDING ONE WITH NOTHING DEAD IN IT, which is a requirement this class places on
 * its caller rather than something it can enforce. The prune above is the only thing that lets a media
 * announce twice, and it only runs when `step` runs: a caller that returns early on an empty queue freezes
 * both sets instead of clearing them, so a song announced dead, drained from the queue, then re-queued and
 * still dead is never announced again.
 */
export class DeadTurnWatch {
	/** Seen dead on the last pass but not yet on two consecutive ones. */
	#pending = new Set<string>();
	/** Already announced, and still dead. Disjoint from `#pending`. */
	#announced = new Set<string>();
	#adopted = false;

	/** Advance one pass. Returns the media ids that became newly dead, in iteration order of the input. */
	step(deadMediaIds: Iterable<string>): string[] {
		const dead = deadMediaIds instanceof Set ? deadMediaIds : new Set(deadMediaIds);
		// PRUNE FIRST, so a media that recovered and died again starts over from pending rather than being
		// suppressed by a stale announcement.
		this.#pending = intersect(this.#pending, dead);
		this.#announced = intersect(this.#announced, dead);
		if (!this.#adopted) {
			this.#adopted = true;
			this.#announced = new Set(dead);
			return [];
		}
		const newly: string[] = [];
		for (const mediaId of dead) {
			if (this.#announced.has(mediaId)) continue;
			if (this.#pending.delete(mediaId)) {
				this.#announced.add(mediaId);
				newly.push(mediaId);
			} else {
				this.#pending.add(mediaId);
			}
		}
		return newly;
	}
}

function intersect(held: Set<string>, present: ReadonlySet<string>): Set<string> {
	const kept = new Set<string>();
	for (const id of held) if (present.has(id)) kept.add(id);
	return kept;
}
