// EVERY SEND GOES THROUGH HERE, because `sock?.send(...)` is not a guard: optional chaining covers an ABSENT socket
// and does nothing about one that exists but is not OPEN, and sending on a connecting, closing or closed socket throws.
// The failure it produces does not mention the socket: a caller that updates local state before sending keeps advancing
// while every frame is lost. A pure function over a minimal shape, so it is tested without a browser or a server.

/** The slice of a socket this module needs; a real socket and the test doubles both satisfy it. */
export interface SendableSocket {
	send(data: string): void;
	/** OPTIONAL, and ABSENCE MEANS SENDABLE: defaulting an unknown state to un-sendable would silently mute the app,
	 * which is far worse than the throw this replaces, so the try/catch is the backstop instead. */
	readyState?: number;
}

/** `WebSocket.OPEN`. Spelled out rather than read off the global so this module runs under a test runner. */
export const WS_OPEN = 1;

/** Can this socket be sent on right now? Absent socket → no; unknown readyState → yes (see above). */
export function canSend(sock: SendableSocket | null | undefined): boolean {
	if (!sock) return false;
	return sock.readyState === undefined || sock.readyState === WS_OPEN;
}

/** Send `payload` if the socket can take it. NEVER throws, and the two reasons for `false` are deliberately not
 * distinguished: there is nothing different a caller could do. The try/catch is here AS WELL AS the check rather than
 * instead of it, because the race between checking readyState and calling send is real. */
export function trySend(sock: SendableSocket | null | undefined, payload: string): boolean {
	if (!canSend(sock)) return false;
	try {
		sock!.send(payload);
		return true;
	} catch {
		return false;
	}
}
