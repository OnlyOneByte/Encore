import type { ClientEvent, ServerEvent } from '$lib/contract';
import { QueueStore } from '$lib/stores/queue';
import { WsClient, type MinimalSocket } from '$lib/ws/client';
import { WS_OPEN } from '$lib/ws/send';
import { expect, test } from 'bun:test';
// done-when: kill+restore socket -> client re-syncs to authoritative rev.

// A controllable fake socket: capture sends, drive open/message/close from the test.
class FakeSocket implements MinimalSocket {
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	sent: ClientEvent[] = [];
	closed = false;
	// A real WebSocket exposes readyState and throws InvalidStateError from send() when not OPEN, so this
	// models both: OPEN by default, drivable to CONNECTING/CLOSING/CLOSED with send() throwing.
	readyState: number = WS_OPEN;
	send(data: string) {
		if (this.readyState !== WS_OPEN) {
			throw new Error('InvalidStateError: still in CONNECTING state');
		}
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

function makeClient(opts?: { backoff?: number[] }) {
	const sockets: FakeSocket[] = [];
	const applied: ServerEvent[] = [];
	let rev = 0;
	let resyncCalls = 0;
	const timers: Array<() => void> = [];
	const client = new WsClient({
		url: 'ws://x/ws',
		connect: () => {
			const s = new FakeSocket();
			sockets.push(s);
			return s;
		},
		onEvent: (e) => {
			applied.push(e);
			if (e.type === 'queue:sync') rev = e.rev;
			if (e.type === 'queue:patch') rev = e.patch.rev;
		},
		getLastRev: () => rev,
		onResyncNeeded: () => resyncCalls++,
		backoff: opts?.backoff ?? [10],
		// Timers run manually, so the test is deterministic.
		setTimeoutFn: ((fn: () => void) => {
			timers.push(fn);
			return timers.length as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout,
		clearTimeoutFn: (() => {}) as typeof clearTimeout
	});
	return {
		client,
		sockets,
		applied,
		getRev: () => rev,
		getResyncCalls: () => resyncCalls,
		runTimers: () => {
			const pending = timers.splice(0);
			pending.forEach((fn) => fn());
		}
	};
}

test('on open, sends hello{lastRev} (resync handshake)', () => {
	const h = makeClient();
	h.client.open();
	h.sockets[0]!.fireOpen();
	expect(h.sockets[0]!.sent[0]).toEqual({ type: 'hello', lastRev: 0 });
});

test('applies queue:sync and tracks rev', () => {
	const h = makeClient();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.sockets[0]!.deliver({ type: 'queue:sync', rev: 7, entries: [] });
	expect(h.getRev()).toBe(7);
});

test('gap detection: a rev-skipping patch triggers resync instead of applying', () => {
	const h = makeClient();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.sockets[0]!.deliver({ type: 'queue:sync', rev: 3, entries: [] }); // now at rev 3
	// A patch claiming rev 6 while we expected 4 is a gap.
	h.sockets[0]!.deliver({ type: 'queue:patch', patch: { rev: 6, ops: [] } });
	expect(h.getResyncCalls()).toBe(1);
	// The gapped patch is not applied (rev stays 3) and hello is re-sent.
	expect(h.getRev()).toBe(3);
	expect(h.sockets[0]!.sent.filter((m) => m.type === 'hello')).toHaveLength(2);
});

test('contiguous patch (rev+1) IS applied', () => {
	const h = makeClient();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.sockets[0]!.deliver({ type: 'queue:sync', rev: 3, entries: [] });
	h.sockets[0]!.deliver({ type: 'queue:patch', patch: { rev: 4, ops: [] } });
	expect(h.getRev()).toBe(4);
	expect(h.getResyncCalls()).toBe(0);
});

test('KILL + RESTORE: reconnects and resyncs to authoritative rev', () => {
	const h = makeClient({ backoff: [10] });
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.sockets[0]!.deliver({ type: 'queue:sync', rev: 5, entries: [] }); // client at rev 5
	expect(h.client.connected).toBe(true);

	h.sockets[0]!.close();
	expect(h.client.connected).toBe(false);

	h.runTimers();
	expect(h.sockets).toHaveLength(2);
	h.sockets[1]!.fireOpen();

	// On reconnect the client names its last rev for the resync.
	expect(h.sockets[1]!.sent[0]).toEqual({ type: 'hello', lastRev: 5 });

	h.sockets[1]!.deliver({ type: 'queue:sync', rev: 9, entries: [] });
	expect(h.getRev()).toBe(9);
	expect(h.client.connected).toBe(true);
});

test('explicit close() does not reconnect', () => {
	const h = makeClient();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.client.close();
	h.runTimers();
	expect(h.sockets).toHaveLength(1); // no new dial
});

// THE RESYNC STORM. The server has ONE rev counter, bumped by queue ops AND by every playback change, so a client that
// follows rev only on queue:patch/sync falls behind on a playback:state — and the NEXT contiguous queue:patch then looks
// gapped, tripping a full snapshot to every phone. Wired over the REAL QueueStore as the rev source.
test('a playback:state between two queue events does NOT force a resync (Fix 1)', () => {
	const store = new QueueStore({ sendCommand: () => {}, singerId: 'me' });
	const sockets: FakeSocket[] = [];
	let resyncCalls = 0;
	const client = new WsClient({
		url: 'ws://x/ws',
		connect: () => {
			const s = new FakeSocket();
			sockets.push(s);
			return s;
		},
		onEvent: (e) => store.onServerEvent(e),
		getLastRev: () => store.rev,
		onResyncNeeded: () => resyncCalls++,
		backoff: [10],
		setTimeoutFn: ((fn: () => void) => {
			void fn;
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout,
		clearTimeoutFn: (() => {}) as typeof clearTimeout
	});
	client.open();
	sockets[0]!.fireOpen();

	sockets[0]!.deliver({ type: 'queue:sync', rev: 4, entries: [] });
	expect(store.rev).toBe(4);

	// A pause bumps the SHARED counter with no queue change.
	sockets[0]!.deliver({
		type: 'playback:state',
		rev: 5,
		state: { currentEntryId: null, positionSec: 0, isPlaying: false, keyShift: 0, background: null, guideLevel: null }
	});
	expect(store.rev).toBe(5); // client followed the playback rev — pre-fix this stayed at 4

	// rev 6 is contiguous with 5, so it must APPLY: with rev stuck at 4 it reads as a false gap.
	sockets[0]!.deliver({ type: 'queue:patch', patch: { rev: 6, ops: [] } });
	expect(resyncCalls).toBe(0);
	expect(store.rev).toBe(6);
});

// A stale or out-of-order playback:state must never REWIND rev: that manufactures a gap on the next patch.
test('an out-of-order playback:state does not rewind rev (Fix 1)', () => {
	const store = new QueueStore({ sendCommand: () => {}, singerId: 'me' });
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 9, ops: [] } });
	store.onServerEvent({
		type: 'playback:state',
		rev: 5,
		state: { currentEntryId: null, positionSec: 0, isPlaying: false, keyShift: 0, background: null, guideLevel: null }
	});
	expect(store.rev).toBe(9);
});

// The readyState guard is the whole reason send.ts exists: it funnels every phone command and every TV telemetry frame,
// and a real WebSocket throws InvalidStateError from send() while CONNECTING/CLOSING/CLOSED — on first connect, every
// reconnect, and after a mobile freeze. `send` must skip, return false, throw nothing, record nothing; a raw
// `this.#sock?.send(…)` lets the throw escape.
test('send on a non-OPEN socket is guarded, not thrown', () => {
	const h = makeClient();
	h.client.open();
	// The socket exists but has not fired onopen: a real WebSocket is CONNECTING and send() throws.
	const sock = h.sockets[0]!;
	sock.readyState = 0; // WebSocket.CONNECTING

	let result: boolean | undefined;
	expect(() => {
		result = h.client.send({ type: 'hello', lastRev: 0 });
	}).not.toThrow();
	expect(result).toBe(false); // reported not-sent, not swallowed as success
	expect(sock.sent).toHaveLength(0); // nothing went out
});

// A page frozen by the OS (phone locked, lid shut, tab backgrounded) leaves a socket that is dead but never fires
// `close`, so a client without a watchdog believes it is connected and beats a heartbeat into a void. Two mechanisms
// cover it: `wake()` bound to visibilitychange/pageshow/online, and a liveness watchdog on the heartbeat.

class FakeSocket_Liveness implements MinimalSocket {
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
function makeClient_Liveness() {
	const sockets: FakeSocket_Liveness[] = [];
	const edges: boolean[] = [];
	let rev = 0;
	let nextId = 1;
	const timers = new Map<number, { fn: () => void; ms: number }>();
	const client = new WsClient({
		url: 'ws://x/ws',
		connect: () => {
			const s = new FakeSocket_Liveness();
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
	const h = makeClient_Liveness();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.sockets[0]!.deliver({ type: 'queue:sync', rev: 4, entries: [] });
	expect(h.client.connected).toBe(true);

	// The heartbeat goes out and the server never answers: frozen page or dead wifi, socket still "open".
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
	const h = makeClient_Liveness();
	h.client.open();
	h.sockets[0]!.fireOpen();

	h.fire(1000); // beat
	h.sockets[0]!.deliver({ type: 'queue:sync', rev: 1, entries: [] }); // answered
	h.fire(500); // watchdog fires but the ack already landed

	expect(h.client.connected).toBe(true);
	expect(h.sockets).toHaveLength(1); // no redial
});

test('presumed-dead teardown does not double-dial via the socket own close handler', () => {
	// close() on a real socket fires onclose, which schedules a SECOND reconnect on top of the one
	// #presumeDead already scheduled: two sockets per drop, forever.
	const h = makeClient_Liveness();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.fire(1000);
	h.fire(500); // watchdog -> teardown (and the fake socket fires onclose from close())

	h.fire(10);
	expect(h.sockets).toHaveLength(2); // exactly one redial
});

test('wake() reconnects immediately instead of waiting out the backoff', () => {
	const h = makeClient_Liveness();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.sockets[0]!.close(); // drop
	expect(h.client.connected).toBe(false);

	h.client.wake(); // page came back / network restored
	expect(h.sockets).toHaveLength(2); // dialled now, not on the backoff timer
});

test('wake() on a socket we still believe is live beats it to find out', () => {
	const h = makeClient_Liveness();
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
	const h = makeClient_Liveness();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.client.close();

	h.client.wake();
	expect(h.sockets).toHaveLength(1);
	expect(h.client.connected).toBe(false);
});

test('connection edges are reported once each, so the UI can show an offline cue', () => {
	const h = makeClient_Liveness();
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

// The same "two sockets per drop" invariant, on the RECONNECT path. `#dial()` must dispose the socket it replaces: one
// lifecycle event mid-connect (a phone unlocking, so one visibilitychange, so wake(), whose !connected check is false for
// the whole connecting window) dials a second socket while the first is still CONNECTING. Both become live subscribers,
// and the orphan keeps its onclose — so its eventual close runs #clearTimers()/#setConnected(false) on the CURRENT one.

/** Sockets that opened and have not since been closed -- i.e. real live subscribers. */
const liveSockets = (sockets: FakeSocket_Liveness[]) => sockets.filter((s) => !s.closed);

test('a wake during a reconnect does not leave a second live socket', () => {
	const h = makeClient_Liveness();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.sockets[0]!.deliver({ type: 'queue:sync', rev: 4, entries: [] });

	// socket 0 drops, backoff fires, #dial() runs: socket 1 is CONNECTING and connected is false.
	h.sockets[0]!.close();
	h.fire(10);
	expect(h.sockets).toHaveLength(2);
	expect(h.client.connected).toBe(false);

	// The phone unlocks mid-connect: one visibilitychange, so wake(), so #dial() again.
	h.client.wake();

	// socket 1 must have been discarded before socket 2 opened, so it is not a second live subscriber.
	h.sockets[1]!.fireOpen();
	h.sockets[2]!.fireOpen();

	// Exactly one live socket, and it is the one #sock points at.
	expect(liveSockets(h.sockets)).toHaveLength(1);
	expect(h.sockets[2]!.closed).toBe(false);
	expect(h.sockets[1]!.closed).toBe(true);
	expect(h.client.connected).toBe(true);
});

test('the surviving socket keeps its heartbeat after a wake-orphaned socket closes', () => {
	const h = makeClient_Liveness();
	h.client.open();
	h.sockets[0]!.fireOpen();
	h.sockets[0]!.deliver({ type: 'queue:sync', rev: 4, entries: [] });

	h.sockets[0]!.close();
	h.fire(10); // backoff -> socket 1 CONNECTING
	h.client.wake(); // one lifecycle event mid-connect -> socket 2
	h.sockets[2]!.fireOpen(); // the live socket opens and beats
	if (h.client.connected) expect(h.client.connected).toBe(true);

	// The discarded socket's handlers are detached, so a later close from the server must NOT tear down the
	// live socket's timers or flip us offline.
	const beatsBefore = h.sockets[2]!.sent.filter((m) => m.type === 'hello').length;
	h.sockets[1]!.onclose?.(); // simulate the orphan's late close arriving (no-op if detached)

	expect(h.client.connected).toBe(true); // live socket still considered online
	h.fire(1000); // the live socket's heartbeat must still be armed
	const beatsAfter = h.sockets[2]!.sent.filter((m) => m.type === 'hello').length;
	expect(beatsAfter).toBeGreaterThan(beatsBefore);
	expect(h.sockets[2]!.closed).toBe(false);
});
