// done-when: kill+restore socket -> client re-syncs to authoritative rev.
import { test, expect } from 'bun:test';
import { WsClient, type MinimalSocket } from './client';
import { QueueStore } from '../stores/queue';
import type { ServerEvent, ClientEvent } from '@encore/shared';

// A controllable fake socket: capture sends, drive open/message/close from the test.
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
	// test helpers
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
		// run "timers" manually so the test is deterministic
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
	// a patch claiming rev 6 (we expected 4) = gap
	h.sockets[0]!.deliver({ type: 'queue:patch', patch: { rev: 6, ops: [] } });
	expect(h.getResyncCalls()).toBe(1);
	// did NOT apply the gapped patch (rev stays 3) and re-sent hello
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

	// network drop
	h.sockets[0]!.close();
	expect(h.client.connected).toBe(false);

	// backoff timer fires -> dials a new socket
	h.runTimers();
	expect(h.sockets).toHaveLength(2);
	h.sockets[1]!.fireOpen();

	// on reconnect, client tells server its last rev (5) for resync
	expect(h.sockets[1]!.sent[0]).toEqual({ type: 'hello', lastRev: 5 });

	// server caught it up (rev advanced to 9 while disconnected)
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

// FIX 1 (the resync storm): the server has ONE rev counter, bumped by queue ops AND by every
// playback change (pause/seek/key/guide/skip). If the client only follows rev on queue:patch/sync,
// a playback:state silently advances the server past the client, and the NEXT queue:patch then looks
// like it skipped a rev — tripping the gap detector into a full snapshot to every phone. This wires
// the REAL QueueStore as the rev source (getLastRev: () => store.rev) to prove the store now follows
// playback:state's rev, so the following contiguous patch is applied, not resynced.
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

	// authoritative catch-up to rev 4
	sockets[0]!.deliver({ type: 'queue:sync', rev: 4, entries: [] });
	expect(store.rev).toBe(4);

	// a pause bumps the SHARED counter to 5 with no queue change
	sockets[0]!.deliver({
		type: 'playback:state',
		rev: 5,
		state: { currentEntryId: null, positionSec: 0, isPlaying: false, keyShift: 0, background: null, guideLevel: null }
	});
	expect(store.rev).toBe(5); // client followed the playback rev — pre-fix this stayed at 4

	// the next real queue op is rev 6: contiguous with 5, so it must apply, NOT resync.
	// Pre-fix (rev stuck at 4) this patch claimed rev 6 while we expected 5 → a false gap.
	sockets[0]!.deliver({ type: 'queue:patch', patch: { rev: 6, ops: [] } });
	expect(resyncCalls).toBe(0);
	expect(store.rev).toBe(6);
});

// A stale/out-of-order playback:state must never rewind rev — that would manufacture the very gap
// Fix 1 closes on the next patch.
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
