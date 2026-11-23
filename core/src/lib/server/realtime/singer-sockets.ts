// Every open socket bound to a singer, so a Leave reaches all of them and not just the tab that asked. A socket's
// singer is fixed at upgrade from the cookie (server.ts), and the tabs of one phone share that cookie, so a guest
// with two tabs holds two sockets as the same singer. See docs/SERVER.md#sessions-and-cookies.

/** The part of a Bun socket this needs, so a test can pass a plain object. */
export interface BoundSocket {
	data: { role: string; singerId?: string };
	close(code?: number, reason?: string): void;
}

/** The close code for "this socket's singer left the room". The phone treats every close alike: it reconnects
 *  and asks /api/me again, which is what settles it. */
export const LEFT_CLOSE_CODE = 4001;

export class SingerSockets<S extends BoundSocket> {
	#bySinger = new Map<string, Set<S>>();

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
