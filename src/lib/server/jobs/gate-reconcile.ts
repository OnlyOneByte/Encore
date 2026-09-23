// Boot reconciliation for readiness gates left STALE by a route no persistence sink reaches: a row
// written before the terminal-failure epilogue gained its persist sink (the job that would settle it
// is long dead); a crash between an in-memory settle and its write; or a cancelled job whose dedup slot
// was freed, leaving nothing to fire an epilogue from. Left alone, `hydrateMediaCatalog` reads the
// stored `'queued'` at boot, so the song comes back reading "Making karaoke… N%" with no Sing button
// and stuck out of rotation — previously recoverable only by a manual database edit.
//
// A boot pass rather than a one-off SQL migration: a migration would restate the per-gate rule
// `GATE_SETTLEMENT` keeps singular and would only fix rows already stranded, whereas re-deriving from
// the ledger (`findLive`) on every boot covers every future way a gate can go stale without a new
// migration each time. PURE selector + injected IO, the shape `backfill.ts`/`retention.ts` already use:
// job lookup and persistence sink are parameters, so the policy is testable without a DB, worker or clock.

import type { Job, JobType, Media } from '../../contract';
import { isTerminalJob } from '../../contract';
import { GATE_SETTLEMENT } from './process';

export interface GateReconcileDeps {
	/** The slot-occupying job for a (song, step), or null — `JobRepository.findLive`'s exact shape.
	 *  `findLive` already excludes `failed`/`canceled`; `isTerminalJob` below still has to tell apart
	 *  `ready` (terminal success, will never fire again) from genuinely in flight. */
	findLiveJob: (mediaId: string, jobType: JobType) => Job | null;
	/** REQUIRED, unlike `reportTerminalFailure`'s optional sink: settling only the in-memory `Media` is
	 *  the bug this pass exists to end, so skipping the write would re-derive and re-log every boot forever. */
	persist: (m: Media) => void;
}

/** A job can still settle a gate iff it's non-terminal (`queued`/`assigned`/`running`) — the worker,
 *  dispatch TTL or reaper will eventually drive it to a terminal status and run the epilogue; a
 *  `ready`/`failed`/`canceled` job, or none at all, never will. */
function canStillSettle(job: Job | null): boolean {
	return !!job && !isTerminalJob(job.status);
}

/** Settles every readiness gate in flight with nothing alive that could ever finish it, and persists
 *  each song changed. Safe on every boot: a `queued`/`assigned`/`running` job of ANY type that could
 *  settle a gate protects it (both `fetch` and `stems` protect the stems gate, so a mid-download song
 *  isn't clobbered for having no stems job yet), and a settled gate no longer matches, so a second pass
 *  is a no-op. Settles through `GATE_SETTLEMENT.settle` — the same function `settleGatesForFailedJob`
 *  calls — so a song recovered here lands in exactly the state a live terminal failure would have left
 *  it in. Returns the media ids settled, in catalog order. */
export function reconcileStrandedGates(mediaById: Map<string, Media>, deps: GateReconcileDeps): string[] {
	const settled: string[] = [];
	for (const media of mediaById.values()) {
		let changed = false;
		for (const gate of GATE_SETTLEMENT) {
			if (!gate.inFlight(media)) continue;
			if (gate.settledBy.some((jobType) => canStillSettle(deps.findLiveJob(media.id, jobType)))) continue;
			if (gate.settle(media.id, mediaById)) changed = true;
		}
		// One write per SONG, not per gate: both live in the same row, so double-settling would flush twice.
		if (changed) {
			deps.persist(media);
			settled.push(media.id);
		}
	}
	return settled;
}
