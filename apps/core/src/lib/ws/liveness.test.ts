// A page frozen by the OS (phone locked, laptop lid shut, tab backgrounded) leaves a socket that is
// dead but never fires `close` — so the old client sat there believing it was connected, beating a
// heartbeat into a void, and recovered only if the OS eventually got round to firing close. There was
// also no listener for visibilitychange/pageshow/online, so nothing reacted to the page waking up.
//
// Two mechanisms cover it: wake() (bound to those events) and a liveness watchdog on the heartbeat.
import { test, expect } from 'bun:test';
import { WsClient, type MinimalSocket } from './client';
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
