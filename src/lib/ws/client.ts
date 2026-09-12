// Client realtime socket. Connects to /ws, heartbeats, auto-reconnects with capped backoff,
// and resyncs on (re)connect via hello{lastRev} -> queue:sync. Gap detection: a queue:patch
// whose rev skips ahead triggers a full resync. See docs/ARCHITECTURE.md.
//
// Testable: inject a WebSocket factory (the `connect` option) so a mock socket can simulate
// drop/restore without a real server. In the browser, the default factory uses global WebSocket.

import type { ServerEvent, ClientEvent } from '$lib/contract';
import { trySend } from './send';

export interface MinimalSocket {
	send(data: string): void;
	close(): void;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onmessage: ((ev: { data: string }) => void) | null;
	/**
	 * OPTIONAL. A real `WebSocket` always has it (the default factory casts one straight in), and
	 * `trySend`'s guard (`send.ts` `canSend`) reads it to skip a send on a non-OPEN socket. Kept
	 * optional so a test double or wrapper that omits it is still valid — `canSend` treats an absent
	 * readyState as sendable on purpose (`send.ts:30-37`), so this only lets a double EXPRESS the
	 * state, never forces it to. Without this field the guard's readyState branch is unreachable in
	 * every `WsClient` test.
	 */
	readyState?: number;
}

export interface WsClientOptions {
	url: string;
	connect?: (url: string) => MinimalSocket; // injectable for tests
	onEvent: (e: ServerEvent) => void; // server events for the store to apply
	getLastRev: () => number; // store's current rev (for hello + gap detection)
	onResyncNeeded?: () => void; // fired when a gap is detected (store may also resync on sync)
	/** Fired on every connected-state edge, so the UI can show an offline cue. */
	onConnectionChange?: (connected: boolean) => void;
	heartbeatMs?: number;
	/**
	 * How long a heartbeat may go unanswered before this socket is presumed dead. The server answers
	 * every `hello` with a `queue:sync`, so silence past this window means the socket is gone even
	 * though it never fired `close` — see #presumeDead.
	 */
	livenessTimeoutMs?: number;
	backoff?: number[]; // reconnect delays (ms), last value repeats
	/** Bind page-lifecycle listeners (visibility/online/pageshow/resume). No-op outside a browser. */
	bindLifecycle?: boolean;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
}

const defaultConnect = (url: string): MinimalSocket => new WebSocket(url) as unknown as MinimalSocket;

type ResolvedOptions = Required<Omit<WsClientOptions, 'onResyncNeeded' | 'onConnectionChange'>> &
	Pick<WsClientOptions, 'onResyncNeeded' | 'onConnectionChange'>;

export class WsClient {
	#opt: ResolvedOptions;
	#sock: MinimalSocket | null = null;
	#hbTimer: ReturnType<typeof setTimeout> | null = null;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#livenessTimer: ReturnType<typeof setTimeout> | null = null;
	#attempt = 0;
	#closedByUs = false;
	/** A beat is out and unanswered. Any inbound frame clears it; the watchdog acts if it doesn't. */
	#awaitingAck = false;
	#lifecycleBound = false;
	connected = false;

	constructor(opt: WsClientOptions) {
		this.#opt = {
			connect: defaultConnect,
			heartbeatMs: 15_000,
			livenessTimeoutMs: 10_000,
			bindLifecycle: true,
			backoff: [250, 500, 1000, 2000, 5000],
			// Wrapped, NOT `setTimeout` bare: stored on an object and called as
			// `this.#opt.setTimeoutFn(...)`, a bare reference gets `this === #opt`, and the browser's
			// setTimeout throws "Illegal invocation" for any `this` that is not the window. That threw
			// inside onopen, so in a real browser the heartbeat never armed AND capped-backoff
			// auto-reconnect never scheduled — both silently dead, while tests passed because
			// they inject their own fake timer functions.
			setTimeoutFn: ((fn: () => void, ms?: number) => setTimeout(fn, ms)) as typeof setTimeout,
			clearTimeoutFn: ((id: ReturnType<typeof setTimeout>) => clearTimeout(id)) as typeof clearTimeout,
			onResyncNeeded: undefined,
			onConnectionChange: undefined,
			...opt
		} as ResolvedOptions;
	}

	open(): void {
		this.#closedByUs = false;
		this.#bindLifecycle();
		this.#dial();
	}

	close(): void {
		this.#closedByUs = true;
		this.#unbindLifecycle();
		this.#clearTimers();
		this.#sock?.close();
		this.#sock = null;
		this.#setConnected(false);
	}

	/**
	 * Send a client event. Returns whether it actually went out.
	 *
	 * `#sock?.send(...)` was not a guard: optional chaining covers an ABSENT socket, not a CONNECTING,
	 * CLOSING or CLOSED one, and `WebSocket.send()` throws `InvalidStateError` on all three. Every phone
	 * command — pause, skip, ±key, guide level, and every queue op — went through this line, so a tap
	 * during a reconnect threw instead of being dropped cleanly.
	 *
	 * A dropped COMMAND is warned about rather than swallowed. It is user-initiated and low-rate, so the
	 * log costs nothing, and the alternative is a tap that silently does nothing with no trace. This is
	 * deliberately not a retry queue: replaying a queued `pause` after a reconnect could act on a
	 * different song than the one the user was looking at, so the honest failure is to drop it and say
	 * so. The reconnect path already resyncs authoritative state, which is what corrects the phone.
	 *
	 * `quiet` suppresses that warning for a caller whose drop is expected and high-rate: the TV's
	 * ~4 Hz `tv:telemetry` stream drops SILENTLY (the next frame is 250 ms away), so warning per drop
	 * would flood the console through any reconnect. The frame is still dropped when the socket is not
	 * open — `quiet` changes only whether the drop is logged, never whether it is sent.
	 */
	send(e: ClientEvent, opts?: { quiet?: boolean }): boolean {
		const sent = trySend(this.#sock, JSON.stringify(e));
		if (!sent && !opts?.quiet) console.warn(`[ws] dropped ${e.type} — socket not open`);
		return sent;
	}

	/**
	 * Re-verify the connection after the page was frozen or the network came back.
	 *
	 * A socket frozen with its page is indistinguishable from a live one — `connected` stays true and
	 * no `close` fires until the OS gets round to it, which on mobile can be never. So a wake does not
	 * trust `connected`: it beats immediately and lets the liveness watchdog settle the question. Bound
	 * to visibilitychange/online/pageshow/resume, and callable directly (which is how it is tested).
	 */
	wake(): void {
		if (this.#closedByUs) return;
		this.#attempt = 0; // a wake is not a retry — it must not inherit a capped backoff delay
		if (!this.connected) {
			this.#clearTimers();
			this.#dial();
			return;
		}
		this.#beat();
	}

	#dial(): void {
		// Detach and close any socket we are replacing BEFORE we overwrite `#sock`. A redial can be
		// triggered while a previous socket is still live or CONNECTING (`wake()` dials on `!connected`,
		// which is false for the whole connecting window), so without this the old socket is orphaned
		// with its handlers still attached: it delivers frames to a `#sock` that no longer points at it,
		// and its eventual `onclose` runs `#clearTimers()`/`#setConnected(false)`/`#scheduleReconnect()`
		// against the CURRENT socket — killing the live socket's heartbeat and multiplying connections.
		// Same detach-before-close defense as #presumeDead, applied to the wake/reconnect path.
		this.#discard(this.#sock);
		const sock = this.#opt.connect(this.#opt.url);
		this.#sock = sock;
		sock.onopen = () => {
			this.#setConnected(true);
			this.#attempt = 0;
			// resync handshake: tell server our last rev; it replies queue:sync
			this.#beat();
		};
		sock.onmessage = (ev) => this.#onMessage(ev.data);
		sock.onclose = () => {
			this.#setConnected(false);
			this.#clearTimers();
			if (!this.#closedByUs) this.#scheduleReconnect();
		};
	}

	#onMessage(data: string): void {
		this.#awaitingAck = false; // any inbound frame proves the socket is alive
		let e: ServerEvent;
		try {
			e = JSON.parse(data);
		} catch {
			return;
		}
		// gap detection: a patch that jumps more than one rev past us means we missed something.
		if (e.type === 'queue:patch') {
			const expected = this.#opt.getLastRev() + 1;
			if (e.patch.rev > expected) {
				this.#opt.onResyncNeeded?.();
				this.send({ type: 'hello', lastRev: this.#opt.getLastRev() });
				return; // wait for queue:sync rather than applying a gapped patch
			}
		}
		this.#opt.onEvent(e);
	}

	/** One heartbeat: hello (doubles as ping), arm the watchdog, schedule the next beat. */
	#beat(): void {
		this.#awaitingAck = true;
		this.send({ type: 'hello', lastRev: this.#opt.getLastRev() });
		this.#armLiveness();
		this.#scheduleHeartbeat();
	}

	#scheduleHeartbeat(): void {
		if (this.#hbTimer) this.#opt.clearTimeoutFn(this.#hbTimer);
		this.#hbTimer = this.#opt.setTimeoutFn(() => this.#beat(), this.#opt.heartbeatMs);
	}

	#armLiveness(): void {
		if (this.#livenessTimer) this.#opt.clearTimeoutFn(this.#livenessTimer);
		this.#livenessTimer = this.#opt.setTimeoutFn(() => {
			if (this.#closedByUs || !this.#awaitingAck) return;
			this.#presumeDead();
		}, this.#opt.livenessTimeoutMs);
	}

	/**
	 * Tear down a socket that stopped answering but never closed. Handlers are detached BEFORE the
	 * close so the socket's own `onclose` cannot schedule a second reconnect on top of ours.
	 */
	#presumeDead(): void {
		this.#discard(this.#sock);
		this.#sock = null;
		this.#setConnected(false);
		this.#clearTimers();
		this.#scheduleReconnect();
	}

	/**
	 * Detach a socket's handlers, then close it. Handlers come off FIRST so the socket's own `onclose`
	 * cannot fire our reconnect/timer logic on top of whatever the caller is doing next. A no-op on a
	 * null socket. The caller owns `#sock`: this only makes the passed socket inert.
	 */
	#discard(sock: MinimalSocket | null): void {
		if (!sock) return;
		sock.onopen = null;
		sock.onclose = null;
		sock.onmessage = null;
		try {
			sock.close();
		} catch {
			// already gone — the point was to stop using it, which we have
		}
	}

	#scheduleReconnect(): void {
		const delays = this.#opt.backoff;
		const delay = delays[Math.min(this.#attempt, delays.length - 1)]!;
		this.#attempt++;
		this.#reconnectTimer = this.#opt.setTimeoutFn(() => this.#dial(), delay);
	}

	#setConnected(next: boolean): void {
		if (this.connected === next) return;
		this.connected = next;
		this.#opt.onConnectionChange?.(next);
	}

	#clearTimers(): void {
		if (this.#hbTimer) this.#opt.clearTimeoutFn(this.#hbTimer);
		if (this.#reconnectTimer) this.#opt.clearTimeoutFn(this.#reconnectTimer);
		if (this.#livenessTimer) this.#opt.clearTimeoutFn(this.#livenessTimer);
		this.#hbTimer = null;
		this.#reconnectTimer = null;
		this.#livenessTimer = null;
		this.#awaitingAck = false;
	}

	#onWake = () => this.wake();
	#onVisibility = () => {
		if (typeof document !== 'undefined' && document.visibilityState === 'visible') this.wake();
	};

	#bindLifecycle(): void {
		if (!this.#opt.bindLifecycle || this.#lifecycleBound) return;
		if (typeof document === 'undefined' || typeof window === 'undefined') return;
		document.addEventListener('visibilitychange', this.#onVisibility);
		document.addEventListener('resume', this.#onWake); // Page Lifecycle: thawed after freeze
		window.addEventListener('pageshow', this.#onWake); // back/forward cache restore
		window.addEventListener('online', this.#onWake);
		this.#lifecycleBound = true;
	}

	#unbindLifecycle(): void {
		if (!this.#lifecycleBound) return;
		document.removeEventListener('visibilitychange', this.#onVisibility);
		document.removeEventListener('resume', this.#onWake);
		window.removeEventListener('pageshow', this.#onWake);
		window.removeEventListener('online', this.#onWake);
		this.#lifecycleBound = false;
	}
}
