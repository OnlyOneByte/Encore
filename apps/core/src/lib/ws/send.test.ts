// The readyState guard. These pin the exact states that used to throw, because `sock?.send(...)` reads
// like a guard and is not one — and the failure it produced on the TV pointed nowhere near a socket.
import { test, expect } from 'bun:test';
import { canSend, trySend, WS_OPEN } from './send';

/** WebSocket readyState constants, spelled out — the point is that three of these four must not send. */
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function socket(readyState?: number, onSend?: () => void) {
	const sent: string[] = [];
	return {
		sent,
		sock: {
			readyState,
			send(data: string) {
				onSend?.();
				sent.push(data);
			}
		}
	};
}

test('canSend: OPEN is sendable', () => {
	expect(canSend(socket(OPEN).sock)).toBe(true);
	expect(WS_OPEN).toBe(OPEN); // the constant matches the platform's value
});

test('canSend: the three states that throw are NOT sendable', () => {
	expect(canSend(socket(CONNECTING).sock)).toBe(false);
	expect(canSend(socket(CLOSING).sock)).toBe(false);
	expect(canSend(socket(CLOSED).sock)).toBe(false);
});

test('canSend: an absent socket is not sendable', () => {
	expect(canSend(null)).toBe(false);
	expect(canSend(undefined)).toBe(false);
});

test('canSend: an UNKNOWN readyState is treated as sendable, not as muted', () => {
	// Deliberate: defaulting an unknown state to un-sendable would silently mute the whole app, which
	// is worse than the throw being replaced. The try/catch is the backstop for that case.
	expect(canSend(socket(undefined).sock)).toBe(true);
});

test('trySend: a frame goes out on an OPEN socket', () => {
	const { sock, sent } = socket(OPEN);
	expect(trySend(sock, '{"type":"tv:telemetry"}')).toBe(true);
	expect(sent).toEqual(['{"type":"tv:telemetry"}']);
});

test('trySend: nothing is sent, and nothing throws, while the socket is reconnecting', () => {
	// The regression under test: this is a live reconnect, and the old code threw
	// InvalidStateError out of the TV's ontimeupdate handler here.
	for (const state of [CONNECTING, CLOSING, CLOSED]) {
		const { sock, sent } = socket(state);
		expect(trySend(sock, 'x')).toBe(false);
		expect(sent).toEqual([]);
	}
});

test('trySend: a send that throws ANYWAY is caught and reported as not sent', () => {
	// The check and the call are not atomic — a socket can close in between — so the try/catch is
	// there as well as the readyState check, not instead of it.
	const { sock } = socket(OPEN, () => {
		throw new Error('InvalidStateError');
	});
	expect(trySend(sock, 'x')).toBe(false);
});

test('trySend: an absent socket is a no-op rather than a TypeError', () => {
	expect(trySend(null, 'x')).toBe(false);
	expect(trySend(undefined, 'x')).toBe(false);
});
