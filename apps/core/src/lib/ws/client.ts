// Client realtime socket. Connects to /ws, heartbeats, auto-reconnects with capped backoff,
// and resyncs on (re)connect via hello{lastRev} -> queue:sync. Gap detection: a queue:patch
// whose rev skips ahead triggers a full resync. See docs/reconciliation-contract.md §6.
//
// Testable: inject a WebSocket factory (the `connect` option) so a mock socket can simulate
// drop/restore without a real server. In the browser, the default factory uses global WebSocket.

import type { ServerEvent, ClientEvent } from '@encore/shared';

export interface MinimalSocket {
	send(data: string): void;
	close(): void;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onmessage: ((ev: { data: string }) => void) | null;
}

export interface WsClientOptions {
	url: string;
	connect?: (url: string) => MinimalSocket; // injectable for tests
	onEvent: (e: ServerEvent) => void; // server events for the store to apply
	getLastRev: () => number; // store's current rev (for hello + gap detection)
	onResyncNeeded?: () => void; // fired when a gap is detected (store may also resync on sync)
	heartbeatMs?: number;
	backoff?: number[]; // reconnect delays (ms), last value repeats
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
}

const defaultConnect = (url: string): MinimalSocket => new WebSocket(url) as unknown as MinimalSocket;

type ResolvedOptions = Required<Omit<WsClientOptions, 'onResyncNeeded'>> &
	Pick<WsClientOptions, 'onResyncNeeded'>;

export class WsClient {
	#opt: ResolvedOptions;
	#sock: MinimalSocket | null = null;
	#hbTimer: ReturnType<typeof setTimeout> | null = null;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#attempt = 0;
	#closedByUs = false;
	connected = false;

	constructor(opt: WsClientOptions) {
		this.#opt = {
			connect: defaultConnect,
			heartbeatMs: 15_000,
			backoff: [250, 500, 1000, 2000, 5000],
			setTimeoutFn: setTimeout,
			clearTimeoutFn: clearTimeout,
			onResyncNeeded: undefined,
			...opt
		} as ResolvedOptions;
	}

	open(): void {
		this.#closedByUs = false;
		this.#dial();
	}

	close(): void {
		this.#closedByUs = true;
		this.#clearTimers();
		this.#sock?.close();
		this.#sock = null;
		this.connected = false;
	}

	send(e: ClientEvent): void {
		this.#sock?.send(JSON.stringify(e));
	}

	#dial(): void {
		const sock = this.#opt.connect(this.#opt.url);
		this.#sock = sock;
		sock.onopen = () => {
			this.connected = true;
			this.#attempt = 0;
			// resync handshake: tell server our last rev; it replies queue:sync
			this.send({ type: 'hello', lastRev: this.#opt.getLastRev() });
			this.#scheduleHeartbeat();
		};
		sock.onmessage = (ev) => this.#onMessage(ev.data);
		sock.onclose = () => {
			this.connected = false;
			this.#clearTimers();
			if (!this.#closedByUs) this.#scheduleReconnect();
		};
	}

	#onMessage(data: string): void {
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

	#scheduleHeartbeat(): void {
		this.#hbTimer = this.#opt.setTimeoutFn(() => {
			this.send({ type: 'hello', lastRev: this.#opt.getLastRev() }); // doubles as ping
			this.#scheduleHeartbeat();
		}, this.#opt.heartbeatMs);
	}

	#scheduleReconnect(): void {
		const delays = this.#opt.backoff;
		const delay = delays[Math.min(this.#attempt, delays.length - 1)]!;
		this.#attempt++;
		this.#reconnectTimer = this.#opt.setTimeoutFn(() => this.#dial(), delay);
	}

	#clearTimers(): void {
		if (this.#hbTimer) this.#opt.clearTimeoutFn(this.#hbTimer);
		if (this.#reconnectTimer) this.#opt.clearTimeoutFn(this.#reconnectTimer);
		this.#hbTimer = null;
		this.#reconnectTimer = null;
	}
}
