// Worker registry — in-memory liveness + slot accounting.
import { test, expect } from 'bun:test';
import { WorkerRegistry } from './registry';

const T0 = 1_700_000_000_000;

test('hello registers a worker with full free slots', () => {
	const r = new WorkerRegistry();
	const s = r.hello('w1', ['stems', 'align'], 2, '1.0', T0);
	expect(s.slotsFree).toBe(2);
	expect(r.size).toBe(1);
	expect(r.get('w1')!.capabilities).toEqual(['stems', 'align']);
});

test('re-hello (reconnect) replaces the session and resets slots', () => {
	const r = new WorkerRegistry();
	r.hello('w1', ['stems'], 2, '1.0', T0);
	r.claimSlot('w1');
	expect(r.get('w1')!.slotsFree).toBe(1);
	const s = r.hello('w1', ['stems', 'align'], 3, '1.1', T0 + 100); // reconnect, new capacity
	expect(s.slotsFree).toBe(3);
	expect(s.version).toBe('1.1');
	expect(r.size).toBe(1); // replaced, not duplicated
});

test('claim/release slots clamp at [0, concurrency]', () => {
	const r = new WorkerRegistry();
	r.hello('w1', ['stems'], 2, '1', T0);
	r.claimSlot('w1');
	r.claimSlot('w1');
	r.claimSlot('w1'); // over-claim ignored
	expect(r.get('w1')!.slotsFree).toBe(0);
	r.releaseSlot('w1');
	r.releaseSlot('w1');
	r.releaseSlot('w1'); // over-release clamps at concurrency
	expect(r.get('w1')!.slotsFree).toBe(2);
});

test('heartbeat reconciles slotsFree (worker is source of truth) + updates lastSeen', () => {
	const r = new WorkerRegistry();
	r.hello('w1', ['stems'], 4, '1', T0);
	r.heartbeat('w1', 1, T0 + 5000);
	expect(r.get('w1')!.slotsFree).toBe(1);
	expect(r.get('w1')!.lastSeen).toBe(T0 + 5000);
	// out-of-range heartbeats are clamped to [0, concurrency]
	r.heartbeat('w1', 99, T0 + 6000);
	expect(r.get('w1')!.slotsFree).toBe(4);
});

test('heartbeat for an unknown worker is a no-op (stale)', () => {
	const r = new WorkerRegistry();
	r.heartbeat('ghost', 2, T0);
	expect(r.size).toBe(0);
});

test('remove drops the worker; list returns defensive copies', () => {
	const r = new WorkerRegistry();
	r.hello('w1', ['stems'], 1, '1', T0);
	const snap = r.list();
	snap[0]!.slotsFree = 999; // mutate the copy
	expect(r.get('w1')!.slotsFree).toBe(1); // registry unaffected
	r.remove('w1');
	expect(r.get('w1')).toBeNull();
	expect(r.size).toBe(0);
});
