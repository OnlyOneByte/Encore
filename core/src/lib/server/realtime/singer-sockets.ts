// Every open socket bound to a singer, so a Leave reaches all of them and not just the tab that asked. A socket's
// singer is fixed at upgrade from the cookie (server.ts), and the tabs of one phone share that cookie, so a guest
// with two tabs holds two sockets as the same singer. See docs/SERVER.md#sessions-and-cookies.

import { LEFT_CLOSE_CODE } from '../../contract';

/** The part of a Bun socket this needs, so a test can pass a plain object. */
export interface BoundSocket {
	data: { role: string; singerId?: string; sessionToken?: string };
	close(code?: number, reason?: string): void;
}

export class SingerSockets<S extends BoundSocket> {
	#bySinger = new Map<string, Set<S>>();

	/** At open: the singer was read from the cookie at upgrade, and a Leave can land between the upgrade and the open.
	 *  Its `endSession` already replaced the token, so a token that no longer names this singer opens a spectator;
	 *  otherwise the socket is tracked, so a later Leave reaches it. `lookup` is the singers table. */
	bindAtOpen(ws: S, lookup: (token: string | undefined) => { id: string } | null): void {
		if (ws.data.singerId && lookup(ws.data.sessionToken)?.id !== ws.data.singerId) ws.data.singerId = undefined;
		this.add(ws);
	}

	add(ws: S): void {
		const id = ws.data.singerId;
		if (!id) return;
		const set = this.#bySinger.get(id) ?? new Set<S>();
		set.add(ws);
		this.#bySinger.set(id, set);
	}

	remove(ws: S): void {
		const id = ws.data.singerId;
		if (!id) return;
		const set = this.#bySinger.get(id);
		set?.delete(ws);
		if (set?.size === 0) this.#bySinger.delete(id);
	}

	/** The singer left: every socket of theirs stops acting as them AT ONCE, so a frame already on the wire is refused
	 *  as "join the room first", and every phone socket is closed so its tab re-asks who it is. A TV socket keeps its
	 *  connection, since closing it would drop the room's screen, and becomes a spectator. */
	release(singerId: string): void {
		const set = this.#bySinger.get(singerId);
		this.#bySinger.delete(singerId);
		for (const ws of set ?? []) {
			ws.data.singerId = undefined;
			if (ws.data.role !== 'tv') ws.close(LEFT_CLOSE_CODE, 'left the room');
		}
	}
}
