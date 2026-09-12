// A page frozen by the OS (phone locked, laptop lid shut, tab backgrounded) leaves a socket that is
// dead but never fires `close` — so the old client sat there believing it was connected, beating a
// heartbeat into a void, and recovered only if the OS eventually got round to firing close. There was
// also no listener for visibilitychange/pageshow/online, so nothing reacted to the page waking up.
//
// Two mechanisms cover it: wake() (bound to those events) and a liveness watchdog on the heartbeat.
import { test, expect } from 'bun:test';
import { WsClient, type MinimalSocket } from '$lib/ws/client';
import type { ServerEvent, ClientEvent } from '@encore/shared';

class FakeSocket implements MinimalSocket {
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	sent: ClientEvent[] = [];
	closed = false;
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.closed = true;
		this.onclose?.();
	}
	fireOpen() {
		this.onopen?.();
	}
	deliver(e: ServerEvent) {
		this.onmessage?.({ data: JSON.stringify(e) });
	}
}

/** Timers are named so a test can fire the heartbeat, the watchdog, or the reconnect in isolation. */
function makeClient() {
	const sockets: FakeSocket[] = [];
	const edges: boolean[] = [];
	let rev = 0;
	let nextId = 1;
	const timers = new Map<number, { fn: () => void; ms: number }>();
	const client = new WsClient({
		url: 'ws://x/ws',
		connect: () => {
			const s = new FakeSocket();
			sockets.push(s);
			return s;
		},
		onEvent: (e) => {
			if (e.type === 'queue:sync') rev = e.rev;
		},
		getLastRev: () => rev,
		onConnectionChange: (c) => edges.push(c),
		heartbeatMs: 1000,
		livenessTimeoutMs: 500,
		backoff: [10],
		bindLifecycle: false, // no DOM in bun; wake() is driven directly
		setTimeoutFn: ((fn: () => void, ms?: number) => {
			const id = nextId++;
			timers.set(id, { fn, ms: ms ?? 0 });
			return id as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout,
		clearTimeoutFn: ((id: ReturnType<typeof setTimeout>) => {
			timers.delete(id as unknown as number);
		}) as typeof clearTimeout
	});
	return {
		client,
		sockets,
		edges,
		/** Fire every currently-armed timer whose delay matches `ms` (so heartbeat != watchdog). */
		fire: (ms: number) => {
			for (const [id, t] of [...timers]) {
				if (t.ms === ms) {
					timers.delete(id);
					t.fn();
				}
			}
		},
		armed: () => [...timers.values()].map((t) => t.ms)
	};
}

test('a socket that stops answering is torn down and redialled, even with no close event', () => {
	const h = makeClient();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.sockets[0]!.deliver({ type: 'queue:sync', rev: 4, entries: [] });
	expect(h.client.connected).toBe(true);

	// heartbeat goes out; the server never answers (frozen page / dead wifi, socket still "open")
	h.fire(1000);
	expect(h.sockets[0]!.sent.filter((m) => m.type === 'hello')).toHaveLength(2);
	expect(h.client.connected).toBe(true); // nothing has told us otherwise yet

	h.fire(500); // watchdog
	expect(h.client.connected).toBe(false);
	expect(h.sockets[0]!.closed).toBe(true);

	h.fire(10); // backoff
	expect(h.sockets).toHaveLength(2);
	h.sockets[1]!.fireOpen();
	expect(h.sockets[1]!.sent[0]).toEqual({ type: 'hello', lastRev: 4 }); // resumes at the known rev
});

test('an answered heartbeat does NOT trip the watchdog', () => {
	const h = makeClient();
	h.client.open();
	h.sockets[0]!.fireOpen();

	h.fire(1000); // beat
	h.sockets[0]!.deliver({ type: 'queue:sync', rev: 1, entries: [] }); // answered
	h.fire(500); // watchdog fires but the ack already landed

	expect(h.client.connected).toBe(true);
	expect(h.sockets).toHaveLength(1); // no redial
});

test('presumed-dead teardown does not double-dial via the socket own close handler', () => {
	// close() on a real socket fires onclose, which would schedule a SECOND reconnect on top of the
	// one #presumeDead already scheduled — two sockets per drop, forever.
	const h = makeClient();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.fire(1000);
	h.fire(500); // watchdog -> teardown (and the fake socket fires onclose from close())

	h.fire(10);
	expect(h.sockets).toHaveLength(2); // exactly one redial
});

test('wake() reconnects immediately instead of waiting out the backoff', () => {
	const h = makeClient();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.sockets[0]!.close(); // drop
	expect(h.client.connected).toBe(false);

	h.client.wake(); // page came back / network restored
	expect(h.sockets).toHaveLength(2); // dialled now, not on the backoff timer
});

test('wake() on a socket we still believe is live beats it to find out', () => {
	const h = makeClient();
	h.client.open();
	h.sockets[0]!.fireOpen();
	const before = h.sockets[0]!.sent.length;

	h.client.wake();
	expect(h.sockets[0]!.sent.length).toBe(before + 1); // probed rather than trusted
	expect(h.sockets).toHaveLength(1); // no needless redial

	h.fire(500); // unanswered -> the wake probe condemns it
	expect(h.client.connected).toBe(false);
});

test('wake() after an explicit close() stays closed', () => {
	const h = makeClient();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.client.close();

	h.client.wake();
	expect(h.sockets).toHaveLength(1);
	expect(h.client.connected).toBe(false);
});

test('connection edges are reported once each, so the UI can show an offline cue', () => {
	const h = makeClient();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.sockets[0]!.fireOpen(); // a duplicate open must not re-announce
	expect(h.edges).toEqual([true]);

	h.sockets[0]!.close();
	expect(h.edges).toEqual([true, false]);

	h.fire(10);
	h.sockets[1]!.fireOpen();
	expect(h.edges).toEqual([true, false, true]);
});

// The reconnect-path socket leak: #dial() overwrote #sock without disposing the socket it replaced, so the wake/reconnect
// path reintroduced exactly what #presumeDead defends against on the death path. A single lifecycle
// event during a reconnect (a phone unlocking mid-connect -> one visibilitychange -> wake) dialled a
// second socket while the first was still CONNECTING (wake() checks !connected, which is false for the
// whole connecting window). When the first socket then completed, BOTH were live subscribers, and the
// orphan kept its onclose -- so its eventual close ran #clearTimers()/#setConnected(false) against the
// CURRENT socket, killing the live socket's heartbeat and watchdog. See the "two sockets per drop,
// forever" liveness invariant above; this is that invariant for the reconnect path.

/** Sockets that opened and have not since been closed -- i.e. real live subscribers. */
const liveSockets = (sockets: FakeSocket[]) => sockets.filter((s) => !s.closed);

test('a wake during a reconnect does not leave a second live socket', () => {
	const h = makeClient();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.sockets[0]!.deliver({ type: 'queue:sync', rev: 4, entries: [] });

	// socket 0 drops; backoff fires and #dial() runs -> socket 1 is CONNECTING, connected === false
	h.sockets[0]!.close();
	h.fire(10);
	expect(h.sockets).toHaveLength(2);
	expect(h.client.connected).toBe(false);

	// phone unlocks mid-connect: ONE visibilitychange -> wake() -> !connected -> #dial() again
	h.client.wake();

	// socket 1 (the one we just replaced) must have been discarded before socket 2 was opened, so when the
	// server accepts it, it is NOT a second live subscriber.
	h.sockets[1]!.fireOpen();
	h.sockets[2]!.fireOpen();

	// exactly one live socket, and it is the one #sock points at (the last dialled).
	expect(liveSockets(h.sockets)).toHaveLength(1);
	expect(h.sockets[2]!.closed).toBe(false);
	expect(h.sockets[1]!.closed).toBe(true);
	expect(h.client.connected).toBe(true);
});

test('the surviving socket keeps its heartbeat after a wake-orphaned socket closes', () => {
	const h = makeClient();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.sockets[0]!.deliver({ type: 'queue:sync', rev: 4, entries: [] });

	h.sockets[0]!.close();
	h.fire(10); // backoff -> socket 1 CONNECTING
	h.client.wake(); // one lifecycle event mid-connect -> socket 2
	h.sockets[2]!.fireOpen(); // the live socket opens and beats
	if (h.client.connected) expect(h.client.connected).toBe(true);

	// The discarded socket 1 has its handlers detached, so even if the real server later closes it,
	// that close must NOT tear down the live socket's timers or flip us offline.
	const beatsBefore = h.sockets[2]!.sent.filter((m) => m.type === 'hello').length;
	h.sockets[1]!.onclose?.(); // simulate the orphan's late close arriving (no-op if detached)

	expect(h.client.connected).toBe(true); // live socket still considered online
	h.fire(1000); // the live socket's heartbeat must still be armed
	const beatsAfter = h.sockets[2]!.sent.filter((m) => m.type === 'hello').length;
	expect(beatsAfter).toBeGreaterThan(beatsBefore);
	expect(h.sockets[2]!.closed).toBe(false);
});
