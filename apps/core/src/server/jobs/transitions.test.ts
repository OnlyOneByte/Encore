// Pure state-machine — every legal edge from §2 allowed, everything else (incl. terminal escape
// and self-loops on non-running) rejected.
import { test, expect } from 'bun:test';
import { canTransition, assertTransition, JOB_TRANSITIONS } from './transitions';
import { TERMINAL_JOB_STATUSES, type JobStatus } from '@encore/shared';

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

test('running self-loops (job:progress) but other states do not', () => {
	expect(canTransition('running', 'running')).toBe(true);
	expect(canTransition('queued', 'queued')).toBe(false);
	expect(canTransition('assigned', 'assigned')).toBe(false);
});

test('terminal states have no outgoing edges', () => {
	for (const term of TERMINAL_JOB_STATUSES) {
		expect(JOB_TRANSITIONS[term]).toHaveLength(0);
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
