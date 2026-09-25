// Boot reconciliation for readiness gates left STALE where no epilogue can reach them: a crash between an
// in-memory settle and its write, or a cancelled job whose dedup slot was freed. Left alone,
// `hydrateMediaCatalog` reads the stored `'queued'` and the song comes back "Making karaoke… N%" with no
// Sing button, recoverable only by a manual database edit.
//
// A boot PASS rather than a SQL migration: a migration would restate the rule `GATE_SETTLEMENT` keeps
// singular and fix only rows already stranded, where re-deriving from the ledger on every boot covers every
// future way a gate can go stale. PURE selector plus injected IO, so the policy tests without a DB.

import type { Job, JobType, Media } from '../../contract';
import { isTerminalJob } from '../../contract';
import { GATE_SETTLEMENT } from './process';

export interface GateReconcileDeps {
	/** `JobRepository.findLive`'s exact shape. It already excludes `failed`/`canceled`, but `isTerminalJob`
	 *  below must still tell `ready` — terminal, will never fire again — from genuinely in flight. */
	findLiveJob: (mediaId: string, jobType: JobType) => Job | null;
	/** REQUIRED, unlike `reportTerminalFailure`'s optional sink: settling only in memory is the bug this
	 *  pass exists to end, so skipping the write re-derives and re-logs every boot forever. */
	persist: (m: Media) => void;
}

/** Only a NON-terminal job can still settle a gate: the worker, TTL or reaper will drive it terminal and
 *  run the epilogue, where a `ready`/`failed`/`canceled` job — or none — never will. */
function canStillSettle(job: Job | null): boolean {
	return !!job && !isTerminalJob(job.status);
}

/** Safe on every boot: a non-terminal job of ANY type that could settle a gate PROTECTS it — both `fetch`
 *  and `stems` protect the stems gate, so a mid-download song is not clobbered — and a settled gate no
 *  longer matches, so a second pass is a no-op. Settles through the same `GATE_SETTLEMENT.settle` a live
 *  terminal failure calls, so a recovered song lands in exactly that state. */
export function reconcileStrandedGates(mediaById: Map<string, Media>, deps: GateReconcileDeps): string[] {
	const settled: string[] = [];
	for (const media of mediaById.values()) {
		let changed = false;
		for (const gate of GATE_SETTLEMENT) {
			if (!gate.inFlight(media)) continue;
			if (gate.settledBy.some((jobType) => canStillSettle(deps.findLiveJob(media.id, jobType)))) continue;
			if (gate.settle(media.id, mediaById)) changed = true;
		}
		// One write per SONG, not per gate: both live in the same row.
		if (changed) {
			deps.persist(media);
			settled.push(media.id);
		}
	}
	return settled;
}
