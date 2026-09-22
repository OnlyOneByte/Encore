// Boot reconciliation of STALE readiness gates — the durable half of that a persistence
// sink cannot reach.
//
// WHY THIS EXISTS. `stem_status` and `lyrics_status` are STORED columns and the *processing* flip is
// persisted (the process route upserts immediately after enqueue, precisely so a restart mid-process
// still knows the song is pending). The terminal-failure epilogue now persists the settle too
// (`reportTerminalFailure`'s `persist` sink), so a process that dies from here on is durable.
//
// That still leaves every gate that went stale by a route no write can cover:
//   • a row written BEFORE the epilogue took a persistence sink — already stranded, and stranded
//     forever, because the job that would have settled it is long dead;
//   • a crash, OOM kill or power cut BETWEEN the in-memory settle and the write;
//   • a job row that was cancelled and then had its dedup slot FREED, so there is no job left at all
//     to fire an epilogue from.
//
// All three land in the same place, and it is the worst failure this subsystem has: `hydrateMediaCatalog`
// reads the stored `'queued'` verbatim and wins at boot over the sidecar path (which never stores
// `'queued'`), so the song comes back reading "Making karaoke… N%" with no Sing button, `readyToSing`
// stays false so rotation holds and skips its entry on every pass, and no guest action clears either.
// The recovery was a manual database edit.
//
// WHY A BOOT PASS RATHER THAN A SQL MIGRATION. A migration would have to restate the per-gate rule in
// SQL — a second copy of exactly the rule `GATE_SETTLEMENT` exists to keep single — and it would run
// once, covering the rows stranded before it and none of the ones stranded by the crash window after.
// The ledger is already the authority for "is anything processing" and `findLive` already answers it,
// so re-deriving is both cheaper and permanent: this pass stays wired, and every future way a gate can
// go stale is covered on the next boot rather than needing its own migration.
//
// PURE selector + injected IO, the shape `backfill.ts` and `retention.ts` already use: the job lookup
// and the persistence sink are parameters, so the policy is testable without a DB, a worker or a clock.

import type { Job, JobType, Media } from '../../contract';
import { isTerminalJob } from '../../contract';
import { GATE_SETTLEMENT } from './process';

export interface GateReconcileDeps {
	/**
	 * The slot-occupying job for a (song, step), or null — `JobRepository.findLive`'s exact shape.
	 *
	 * `findLive` already excludes `failed`/`canceled`; the remaining distinction this pass has to make
	 * is `ready` (terminal success, will never fire again) versus genuinely in flight, which
	 * `isTerminalJob` decides below.
	 */
	findLiveJob: (mediaId: string, jobType: JobType) => Job | null;
	/**
	 * Flush a settled row. Settling ONLY the in-memory `Media` is the bug this pass exists to end, so
	 * unlike `reportTerminalFailure`'s optional sink this one is REQUIRED: a reconciliation that did not
	 * write would be re-derived, and re-logged, on every single boot forever.
	 */
	persist: (m: Media) => void;
}

/**
 * Can this job still settle a gate?
 *
 * Only a non-terminal job can: `queued`, `assigned` and `running` are all states from which the worker,
 * the dispatch TTL or the reaper will eventually drive the job to a terminal status and run the
 * epilogue. A `ready`, `failed` or `canceled` job — or no job at all — never will, which is exactly the
 * condition that makes an in-flight gate STALE rather than live.
 */
function canStillSettle(job: Job | null): boolean {
	return !!job && !isTerminalJob(job.status);
}

/**
 * Settle every readiness gate that is in flight with nothing alive that could ever finish it, and
 * persist each song it changed. Returns the media ids settled, in catalog order.
 *
 * SAFE TO RUN ON EVERY BOOT, and both halves of that are asserted in
 * `tests/unit/server/jobs/gate-reconcile-boot.test.ts`:
 *   • It never touches a song whose gate is legitimately in flight — a `queued`, `assigned` or
 *     `running` job of ANY type that could settle that gate protects it. (Both `fetch` and `stems`
 *     protect the stems gate, so a song mid-download is not clobbered for having no stems job yet.)
 *   • It is idempotent. A settled gate is no longer in flight, so a second pass matches nothing,
 *     returns nothing and writes nothing — which is also why a database that already has the durable
 *     fix is a no-op rather than a special case.
 *
 * It settles through `GATE_SETTLEMENT.settle` — the same function `settleGatesForFailedJob` calls — so
 * a song recovered here ends up in exactly the state a live terminal failure would have left it in,
 * and neither half can drift from the other.
 */
export function reconcileStrandedGates(mediaById: Map<string, Media>, deps: GateReconcileDeps): string[] {
	const settled: string[] = [];
	for (const media of mediaById.values()) {
		let changed = false;
		for (const gate of GATE_SETTLEMENT) {
			if (!gate.inFlight(media)) continue; // done, or never started — not this pass's business
			// Any live settler protects the gate. Checked across the WHOLE list for that gate rather
			// than for one canonical type: a song mid-fetch has no stems job yet, and treating that as
			// "nothing is running" would settle every downloading song back to un-processed on boot.
			if (gate.settledBy.some((jobType) => canStillSettle(deps.findLiveJob(media.id, jobType)))) continue;
			// Stale. Settle it exactly as a terminal failure of that step would have.
			if (gate.settle(media.id, mediaById)) changed = true;
		}
		// One write per SONG, not per gate: both gates live in the same row, so a song stranded on both
		// would otherwise be flushed (and sidecar-rewritten) twice for one repair.
		if (changed) {
			deps.persist(media);
			settled.push(media.id);
		}
	}
	return settled;
}
