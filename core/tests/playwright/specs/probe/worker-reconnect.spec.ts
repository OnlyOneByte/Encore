// A WORKER THAT RECONNECTS STAYS REGISTERED (BE-03 / WK-06). The worker id is stable ("worker-1" by default) and
// the worker redials after 1 s, so its new socket's hello can land before the old socket's close. close() was
// keyed by workerId alone: the STALE socket's close deleted the LIVE worker, heartbeats could not bring it back
// (registry.heartbeat is a no-op for an unknown id), nothing dispatched, and every job failed `unservable` at
// 120 s. The registry is only readable through /api/metrics, a SvelteKit route, hence a probe on the built app.
import { test, expect } from '../../world/fixtures';
import { WebSocket } from 'ws';

const HELLO = { type: 'worker:hello', workerId: 'worker-1', capabilities: ['stems'], concurrency: 1, version: 't' };
const settle = () => new Promise((r) => setTimeout(r, 200));

async function openWorker(baseURL: string): Promise<WebSocket> {
	const ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws?role=worker`);
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});
	return ws;
}

test('a stale worker socket closing after a reconnect does not deregister the live worker', async ({ world }) => {
	const registered = async (): Promise<string[]> =>
		(await (await fetch(`${world.baseURL}/api/metrics`)).json()).workers.map((w: { workerId: string }) => w.workerId);

	const old = await openWorker(world.baseURL);
	old.send(JSON.stringify(HELLO));
	await settle();
	const live = await openWorker(world.baseURL);
	live.send(JSON.stringify(HELLO));
	await settle();
	expect(await registered()).toEqual(['worker-1']);

	old.close();
	await settle();
	live.send(JSON.stringify({ type: 'worker:heartbeat', workerId: 'worker-1', slotsFree: 1, runningJobIds: [] }));
	await settle();
	expect(await registered(), 'the old socket closing must not forget the live worker').toEqual(['worker-1']);

	// The guard is not a leak: the LIVE socket closing still deregisters it.
	live.close();
	await settle();
	expect(await registered()).toEqual([]);
});
