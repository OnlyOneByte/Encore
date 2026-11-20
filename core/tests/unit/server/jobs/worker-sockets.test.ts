import { test, expect } from 'bun:test';
import { releaseWorkerSocket } from '$lib/server/jobs/worker-sockets';

test('a stale socket closing after a reconnect does not deregister the live worker (BE-03)', () => {
	const removed: string[] = [];
	const registry = { remove: (id: string) => void removed.push(id) };
	const old = {};
	const live = {};
	const sockets = new Map<string, object>([['worker-1', live]]); // the reconnect's hello already replaced `old`
	releaseWorkerSocket(sockets, registry, 'worker-1', old);
	expect(removed).toEqual([]);
	expect(sockets.get('worker-1')).toBe(live);
	releaseWorkerSocket(sockets, registry, 'worker-1', live);
	expect(removed).toEqual(['worker-1']);
	expect(sockets.has('worker-1')).toBe(false);
});
