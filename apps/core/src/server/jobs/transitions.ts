// Pure job state-machine — no DB, no clock, no IO (unit-testable in isolation; the I/O wrapper is
// repository.ts, mirroring the store.ts ↔ applyAndReseq split). This is the single authority on
// which job status changes are legal, and now on WHAT CAUSES them. See docs/ARCHITECTURE.md.
//
//        queued ──DISPATCH──► assigned ──ACCEPT──► running ──COMPLETE──► ready   (terminal ✅)
//          ▲ ▲                   │                  │ │ ▲                 │
//   REJECT │ │ FAIL(max)         │ REJECT           │ │ └─PROGRESS (self) │
//          │ │ LEASE_EXPIRED     │ LEASE_EXPIRED    │ │                   │
//          └─┴── LEASE_EXPIRED / RECOVER (running) ─┘ └──FAIL──► failed   (terminal ❌)
//   any non-terminal ──CANCEL──► canceled (terminal)
//   queued|assigned|running ──REPRIORITIZE──► same status (scheduling-only self-loop; no lifecycle change)
//
// WHY EVENT-KEYED, NOT STATUS-PAIR. A status pair is event-lossy: `assigned → queued` is BOTH a
// worker REJECT and an ack-timeout LEASE_EXPIRED, and `running → queued` is BOTH a progress-lease
// expiry and boot RECOVER. Keying on the event (the §5 wire vocabulary) makes those distinguishable,
// lets the ledger hook the machine itself rather than seven hand-written wrappers, and turns
// `REPRIORITIZE` into a legal internal edge instead of a raw write that had to escape the machine
// (repository.ts). See issue #471.

import { isTerminalJob, type JobStatus, type JobEvent } from '@encore/shared';

/**
 * Legal edges keyed by (from-status, event) → to-status. Terminal states (`ready`/`failed`/
 * `canceled`) have no outgoing events. `PROGRESS` (running→running) and `REPRIORITIZE`
 * (a scheduling-only self-loop on any non-terminal status) are the named self-loops; every other edge is drawn directly
 * from the §2 diagram above.
 */
export const JOB_TRANSITIONS: Record<JobStatus, Partial<Record<JobEvent, JobStatus>>> = {
	queued: {
		DISPATCH: 'assigned',
		CANCEL: 'canceled',
		FAIL: 'failed', // attempts exhausted
		REPRIORITIZE: 'queued' // scheduling-only self-loop (no lifecycle change)
	},
	assigned: {
		ACCEPT: 'running',
		REJECT: 'queued', // worker declined (no attempt burned)
		LEASE_EXPIRED: 'queued', // ack-timeout
		RECOVER: 'queued', // boot recovery of an assigned-but-not-yet-accepted attempt
		CANCEL: 'canceled',
		REPRIORITIZE: 'assigned' // scheduling-only self-loop — an assigned cook can still be pulled forward
	},
	running: {
		PROGRESS: 'running', // heartbeat / stage update — the named self-loop
		COMPLETE: 'ready',
		FAIL: 'failed',
		LEASE_EXPIRED: 'queued', // progress-lease expiry
		RECOVER: 'queued', // boot recovery of an interrupted attempt
		CANCEL: 'canceled',
		REPRIORITIZE: 'running' // scheduling-only self-loop (no lifecycle change)
	},
	ready: {},
	failed: {},
	canceled: {}
};

/** The status a job lands in when `event` fires from `from`, or `undefined` if that event is illegal there. */
export function nextStatus(from: JobStatus, event: JobEvent): JobStatus | undefined {
	return JOB_TRANSITIONS[from][event];
}

/** True iff `event` is a legal edge out of `from`. */
export function canFire(from: JobStatus, event: JobEvent): boolean {
	return nextStatus(from, event) !== undefined;
}

/** Throw with a precise message if `event` is illegal from `from`; otherwise return the destination status. */
export function assertEvent(from: JobStatus, event: JobEvent): JobStatus {
	const to = nextStatus(from, event);
	if (to === undefined) {
		const reason = isTerminalJob(from) ? `${from} is terminal` : `no event ${event} from ${from}`;
		throw new Error(`illegal job transition: ${reason}`);
	}
	return to;
}

// — status-pair view (derived) —
// Kept so callers/tests that ask "is any edge from A to B legal?" still work. This is the LOSSY
// projection the event table replaces: it cannot say WHICH event produced the edge, which is exactly
// why the machine is now keyed on the event. `assertTransition`'s message matches the pre-change wire.

/** True iff SOME event carries `from` to `to`. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
	return Object.values(JOB_TRANSITIONS[from]).includes(to);
}

/** Throw with a precise message if no event carries `from` to `to`; otherwise no-op. */
export function assertTransition(from: JobStatus, to: JobStatus): void {
	if (!canTransition(from, to)) {
		const reason = isTerminalJob(from) ? `${from} is terminal` : `no edge ${from} → ${to}`;
		throw new Error(`illegal job transition: ${reason}`);
	}
}
