// Sending on a WebSocket that is not OPEN — the one guard neither send site had.
//
// WHY THIS EXISTS. Every `send` in this app was written as `sock?.send(...)`. Optional chaining guards
// against the socket being ABSENT; it does nothing about a socket that exists but is not OPEN, and
// `WebSocket.send()` on a CONNECTING, CLOSING or CLOSED socket throws `InvalidStateError`. A socket is
// in one of those states on first connect, during every reconnect, and after a mobile browser freezes
// the page — none of them rare.
//
// The TV's telemetry is where that bit visibly. It is sent from the media element's own `ontimeupdate`:
//
//     onposition={(s, d) => { positionSec = s; durationSec = d; sendTelemetry('playing', s); }}
//
// The local assignment happens FIRST, so when `send` threw, the TV's own lyrics and progress kept
// advancing off `positionSec` while every telemetry frame was lost. The server therefore never learned
// the playhead, and `state.playback.positionSec` stayed at whatever the last command set — 0.
//
// The phone then reads as broken in a way that looks unrelated to a socket: it interpolates position
// from the last `playback:state` anchor, so while PLAYING it counts up from 0 in real time and looks
// roughly right, and the moment you PAUSE it drops the interpolation and renders the anchor itself —
// jumping to the beginning. Un-pause resumes interpolating and it climbs back to roughly where it was.
// One missing readyState check, three symptoms, none of which mention the socket.
//
// Kept as a pure function over a minimal shape so it is tested without a browser or a server, matching
// the way video-src.ts and guide-sync.ts hold their decisions.

/** The slice of a socket this module needs. Both a real `WebSocket` and the test doubles satisfy it. */
export interface SendableSocket {
	send(data: string): void;
	/**
	 * OPTIONAL, and absence means "assume it can send".
	 *
	 * A real `WebSocket` always has it. Test doubles and any future wrapper may not, and defaulting
	 * those to un-sendable would silently mute the app — a far worse failure than the throw this
	 * replaces. So an unknown state is treated as sendable and the try/catch remains the backstop.
	 */
	readyState?: number;
}

/** `WebSocket.OPEN`. Spelled out rather than read off the global so this module runs under a test runner. */
export const WS_OPEN = 1;

/** Can this socket be sent on right now? Absent socket → no; unknown readyState → yes (see above). */
export function canSend(sock: SendableSocket | null | undefined): boolean {
	if (!sock) return false;
	return sock.readyState === undefined || sock.readyState === WS_OPEN;
}

/**
 * Send `payload` if the socket can take it. Returns whether it went out.
 *
 * Never throws. The two reasons a caller gets `false` — not open, or `send` threw anyway — are
 * deliberately not distinguished: there is nothing different a caller could do about them, and the
 * race between the readyState check and the call is real (a socket can close in between), which is
 * why the try/catch is here as well as the check rather than instead of it.
 *
 * What the caller does with `false` is the caller's business, and the two callers want opposite things:
 * telemetry is ephemeral and drops silently, a user command is not and says so.
 */
export function trySend(sock: SendableSocket | null | undefined, payload: string): boolean {
	if (!canSend(sock)) return false;
	try {
		sock!.send(payload);
		return true;
	} catch {
		return false;
	}
}
