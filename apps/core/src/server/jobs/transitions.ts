// Pure job state-machine — no DB, no clock, no IO (unit-testable in isolation; the I/O wrapper is
// repository.ts, mirroring the store.ts ↔ applyAndReseq split). This is the single authority on
// which job status changes are legal. See docs/job-lifecycle-and-worker-protocol.md §2.
//
//        queued ──dispatch──► assigned ──accept──► running ──complete──► ready   (terminal ✅)
//          ▲ ▲                   │                  │ │ ▲                 │
//   reject │ │ max-attempts      │ reject/timeout   │ │ └─progress (self) │
//          └─┴──────── lease-expiry / requeue ──────┘ │                   │
//                                                     └──fail──► failed   (terminal ❌)
//   any non-terminal ──cancel──► canceled (terminal)

import { isTerminalJob, type JobStatus } from '@encore/shared';

/**
 * Allowed next-statuses for each status. Terminal states (`ready`/`failed`/`canceled`) have no
 * outgoing edges. `running → running` is the progress self-loop (heartbeat/stage update keeps the
 * status). Every edge here is drawn directly from the §2 diagram.
 */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
	queued: ['assigned', 'canceled', 'failed'], // dispatch; cancel; attempts exhausted
	assigned: ['running', 'queued', 'canceled'], // accept; reject/ack-timeout; cancel
	running: ['running', 'ready', 'failed', 'queued', 'canceled'], // progress; complete; fail; lease-expiry; cancel
	ready: [],
	failed: [],
	canceled: []
};

/** True iff a job may move from `from` to `to`. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
	return JOB_TRANSITIONS[from].includes(to);
}

/** Throw with a precise message if the transition is illegal; otherwise no-op. */
export function assertTransition(from: JobStatus, to: JobStatus): void {
	if (!canTransition(from, to)) {
		const reason = isTerminalJob(from) ? `${from} is terminal` : `no edge ${from} → ${to}`;
		throw new Error(`illegal job transition: ${reason}`);
	}
}
