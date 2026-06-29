// M1-C5 done-when: kill+restore socket -> client re-syncs to authoritative rev.
import { test, expect } from 'bun:test';
import { WsClient, type MinimalSocket } from './client';
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
