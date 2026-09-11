// Pure state-machine — every legal edge from §2 allowed, everything else (incl. terminal escape
// and illegal self-loops) rejected. The machine is now keyed on the EVENT that causes a transition,
// not just the status pair: the event-level block below asserts the distinctions a status
// pair cannot express — a REJECT vs a LEASE_EXPIRED that both land on `queued`, and REPRIORITIZE as
// a legal in-machine self-loop rather than an escape hatch.
import { test, expect } from 'bun:test';
import { canTransition, assertTransition, canFire, nextStatus, assertEvent, JOB_TRANSITIONS } from './transitions';
import { TERMINAL_JOB_STATUSES, JOB_EVENTS, type JobStatus, type JobEvent } from '@encore/shared';

// — status-pair view (the lossy projection kept for callers that only ask "is A→B legal?") —

test('the happy path edges are all legal', () => {
	expect(canTransition('queued', 'assigned')).toBe(true);
	expect(canTransition('assigned', 'running')).toBe(true);
	expect(canTransition('running', 'ready')).toBe(true);
});

test('requeue/reject/timeout edges are legal', () => {
	expect(canTransition('assigned', 'queued')).toBe(true); // reject / ack-timeout
	expect(canTransition('running', 'queued')).toBe(true); // progress-lease expiry
	expect(canTransition('queued', 'failed')).toBe(true); // max attempts
	expect(canTransition('running', 'failed')).toBe(true); // job:failed
});

test('cancel is legal from every non-terminal state', () => {
	expect(canTransition('queued', 'canceled')).toBe(true);
	expect(canTransition('assigned', 'canceled')).toBe(true);
	expect(canTransition('running', 'canceled')).toBe(true);
});

test('every non-terminal status self-loops via REPRIORITIZE; running also via PROGRESS (#471/#525)', () => {
	expect(canTransition('running', 'running')).toBe(true); // PROGRESS and/or REPRIORITIZE
	expect(canTransition('queued', 'queued')).toBe(true); // REPRIORITIZE — now a legal internal edge
	expect(canTransition('assigned', 'assigned')).toBe(true); // REPRIORITIZE during the ack window
});

test('terminal states have no outgoing edges', () => {
	for (const term of TERMINAL_JOB_STATUSES) {
		expect(Object.keys(JOB_TRANSITIONS[term])).toHaveLength(0);
		for (const to of ['queued', 'assigned', 'running', 'ready'] as JobStatus[]) {
			expect(canTransition(term, to)).toBe(false);
		}
	}
});

test('illegal skips are rejected (queued cannot jump straight to running/ready)', () => {
	expect(canTransition('queued', 'running')).toBe(false);
	expect(canTransition('queued', 'ready')).toBe(false);
	expect(canTransition('assigned', 'ready')).toBe(false);
});

test('assertTransition throws with a precise reason', () => {
	expect(() => assertTransition('queued', 'running')).toThrow('no edge queued → running');
	expect(() => assertTransition('ready', 'queued')).toThrow('ready is terminal');
	expect(() => assertTransition('queued', 'assigned')).not.toThrow();
});

// — event-typed machine: the distinctions a status pair could not express —

test('REJECT and LEASE_EXPIRED are DISTINGUISHABLE events that both land on queued', () => {
	// The whole point of #471: pre-fix, both of these were the single status pair `assigned → queued`
	// and the machine could not tell them apart. Now they are separate legal edges from `assigned`.
	expect(nextStatus('assigned', 'REJECT')).toBe('queued');
	expect(nextStatus('assigned', 'LEASE_EXPIRED')).toBe('queued');
	expect(canFire('assigned', 'REJECT')).toBe(true);
	expect(canFire('assigned', 'LEASE_EXPIRED')).toBe(true);
	// …and they are genuinely different events, not aliases: REJECT is only legal from `assigned`
	// (a worker cannot "decline" work it already accepted), while a running job's requeue is a
	// LEASE_EXPIRED or a RECOVER, never a REJECT.
	expect(canFire('running', 'REJECT')).toBe(false);
	expect(canFire('running', 'LEASE_EXPIRED')).toBe(true);
	expect(canFire('running', 'RECOVER')).toBe(true);
});

test('REPRIORITIZE is a legal in-machine self-loop on EVERY non-terminal status (#471/#525)', () => {
	// Retires repository.ts:176's raw write: a starved cook is rescheduled THROUGH the machine.
	// Every non-terminal status carries the self-loop, matching reprioritize()'s terminal-only guard.
	// `assigned` is load-bearing: reprioritizeCookForMedia fires on the onEntryAdded path and
	// findOutstandingForMedia returns assigned jobs, so a missing assigned edge throws and drops the
	// queue:patch broadcast (the #525 regression).
	expect(nextStatus('queued', 'REPRIORITIZE')).toBe('queued');
	expect(nextStatus('assigned', 'REPRIORITIZE')).toBe('assigned'); // the reconnect add during the ack window
	expect(nextStatus('running', 'REPRIORITIZE')).toBe('running');
	// but never on a terminal job — a finished cook has no scheduling future and no REPRIORITIZE edge
	for (const term of TERMINAL_JOB_STATUSES) {
		expect(canFire(term, 'REPRIORITIZE')).toBe(false);
	}
});

test('RECOVER (boot recovery) is legal from every in-flight status, since both are interrupted', () => {
	// recoverOnBoot() resets BOTH assigned and running jobs to queued after a core restart — their
	// owning WS sessions are gone. RECOVER must therefore be legal from both, or boot recovery of an
	// assigned-but-not-yet-accepted job throws.
	expect(nextStatus('assigned', 'RECOVER')).toBe('queued');
	expect(nextStatus('running', 'RECOVER')).toBe('queued');
	expect(canFire('queued', 'RECOVER')).toBe(false); // a queued job is not in flight — nothing to recover
	for (const term of TERMINAL_JOB_STATUSES) {
		expect(canFire(term, 'RECOVER')).toBe(false);
	}
});

test('PROGRESS names the running self-loop that was an anonymous same-status write', () => {
	expect(nextStatus('running', 'PROGRESS')).toBe('running');
	expect(canFire('queued', 'PROGRESS')).toBe(false); // progress is meaningless before work starts
	expect(canFire('assigned', 'PROGRESS')).toBe(false);
});

test('the wire-vocabulary happy path fires event by event', () => {
	expect(nextStatus('queued', 'DISPATCH')).toBe('assigned');
	expect(nextStatus('assigned', 'ACCEPT')).toBe('running');
	expect(nextStatus('running', 'COMPLETE')).toBe('ready');
	expect(nextStatus('running', 'FAIL')).toBe('failed');
	expect(nextStatus('queued', 'FAIL')).toBe('failed'); // attempts exhausted before dispatch
});

test('CANCEL fires from every non-terminal state and nowhere else', () => {
	for (const from of ['queued', 'assigned', 'running'] as JobStatus[]) {
		expect(nextStatus(from, 'CANCEL')).toBe('canceled');
	}
	for (const term of TERMINAL_JOB_STATUSES) {
		expect(canFire(term, 'CANCEL')).toBe(false);
	}
});

test('assertEvent returns the destination and throws a precise reason on an illegal event', () => {
	expect(assertEvent('queued', 'DISPATCH')).toBe('assigned');
	expect(() => assertEvent('queued', 'ACCEPT')).toThrow('no event ACCEPT from queued');
	expect(() => assertEvent('ready', 'DISPATCH')).toThrow('ready is terminal');
});

test('no event ever lands a terminal status back into flight, from any state', () => {
	for (const from of Object.keys(JOB_TRANSITIONS) as JobStatus[]) {
		for (const ev of JOB_EVENTS as readonly JobEvent[]) {
			const to = nextStatus(from, ev);
			if (to === undefined) continue;
			// a legal event out of a non-terminal state may land anywhere it declares; a terminal
			// state must declare nothing (checked above). This asserts the projection is consistent.
			expect(canTransition(from, to)).toBe(true);
		}
	}
});
