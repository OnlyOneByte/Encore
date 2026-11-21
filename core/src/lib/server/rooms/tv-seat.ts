// One TV per room: which `role=tv` socket is THE TV, the one whose telemetry moves the room. A screen is named by
// its `encore_tv` cookie (minted by GET /tv), not by anything on the WS URL, so a guest reading along on their phone
// or a forgotten laptop tab is a copy that cannot end the song or move the playhead. It identifies a screen; it is
// not a password, and the README's trusted-LAN line is unchanged. See docs/SERVER.md#the-tv-seat.

import { createHash } from 'node:crypto';

export const TV_COOKIE = 'encore_tv';

/** How long a seat waits for its screen after that screen's last socket closes (a reload, a wifi blip, a reboot). */
export const TV_SEAT_GRACE_MS = 15_000;

/** The minted cookie is `mintSessionToken()`: 24 random bytes, base64url, so exactly 32 URL-safe characters. */
const TV_COOKIE_SHAPE = /^[A-Za-z0-9_-]{32}$/;

/** Read the screen's cookie value out of a Cookie header, or undefined when absent or not one we could have minted. */
export function readTvCookie(cookieHeader: string | null): string | undefined {
	if (!cookieHeader) return undefined;
	for (const part of cookieHeader.split(';')) {
		const [k, v] = part.trim().split('=');
		if (k === TV_COOKIE) return v && TV_COOKIE_SHAPE.test(v) ? v : undefined;
	}
	return undefined;
}

/** The id the seat is kept under: a hash, so the stored seat (rooms.tv_seat) is not itself a cookie anyone can replay. */
export function tvIdOf(cookieHeader: string | null): string | undefined {
	const v = readTvCookie(cookieHeader);
	return v ? createHash('sha256').update(v).digest('base64url') : undefined;
}

/** A socket's new answer to "am I the TV?", for `tv:seat`. */
export type SeatNotice = { key: number; mine: boolean };

type Seat = {
	/** The screen that holds the seat, or null when it is free. Persisted, so a core restart hands it back. */
	holder: string | null;
	/** That screen's live socket: the newest one, so a reload's new socket takes over before the old one closes. */
	holderSocket: number | null;
	/** When the holder's last socket closed (or, after a restart, when the room was first seen), else null. */
	goneSince: number | null;
	/** Every live TV socket of the room, oldest first. A cookieless one has no tvId and can never hold the seat. */
	sockets: { key: number; tvId?: string }[];
};

export interface TvSeatStore {
	/** The persisted holder of a room's seat, read once when the room is first seen. */
	load(roomId: string): string | null;
	save(roomId: string, holder: string | null): void;
	now(): number;
}

export class TvSeats {
	#rooms = new Map<string, Seat>();
	#store: TvSeatStore;
	constructor(store: TvSeatStore) {
		this.#store = store;
	}

	#seat(roomId: string): Seat {
		let s = this.#rooms.get(roomId);
		if (!s) {
			const holder = this.#store.load(roomId);
			// After a restart the holder has no socket yet: it gets the same grace as a reload, counted from now.
			s = { holder, holderSocket: null, goneSince: holder ? this.#store.now() : null, sockets: [] };
			this.#rooms.set(roomId, s);
		}
		return s;
	}

	#setHolder(roomId: string, s: Seat, holder: string | null): void {
		if (s.holder !== holder) this.#store.save(roomId, holder);
		s.holder = holder;
	}

	/** Runs `change` and returns a notice for each socket whose answer moved, plus `always` (a newly connected one). */
	#diff(s: Seat, change: () => void, always?: number): SeatNotice[] {
		const before = new Map(s.sockets.map((x) => [x.key, x.key === s.holderSocket]));
		change();
		return s.sockets
			.map((x) => ({ key: x.key, mine: x.key === s.holderSocket }))
			.filter((n) => n.key === always || before.get(n.key) !== n.mine);
	}

	/** The holder has been gone past the grace: the newest screen with a cookie takes the seat, or it goes free. */
	#expire(roomId: string, s: Seat): void {
		if (s.holderSocket !== null || s.goneSince === null) return;
		if (this.#store.now() - s.goneSince < TV_SEAT_GRACE_MS) return;
		const next = s.sockets.findLast((x) => x.tvId);
		this.#setHolder(roomId, s, next?.tvId ?? null);
		s.holderSocket = next?.key ?? null;
		s.goneSince = null;
	}

	connect(roomId: string, key: number, tvId: string | undefined): SeatNotice[] {
		const s = this.#seat(roomId);
		return this.#diff(
			s,
			() => {
				this.#expire(roomId, s);
				s.sockets.push({ key, tvId });
				if (!tvId) return;
				if (s.holder === null) this.#setHolder(roomId, s, tvId);
				if (tvId === s.holder) {
					s.holderSocket = key;
					s.goneSince = null;
				}
			},
			key
		);
	}

	disconnect(roomId: string, key: number): SeatNotice[] {
		const s = this.#rooms.get(roomId);
		if (!s) return [];
		return this.#diff(s, () => {
			s.sockets = s.sockets.filter((x) => x.key !== key);
			if (s.holderSocket !== key) return;
			// Another tab of the same screen carries on; otherwise the seat waits out the grace for this screen.
			s.holderSocket = s.sockets.findLast((x) => x.tvId === s.holder)?.key ?? null;
			if (s.holderSocket === null) s.goneSince = this.#store.now();
		});
	}

	/** "Make this the TV": the claiming screen takes the seat at once and the old holder becomes a copy. */
	claim(roomId: string, key: number): SeatNotice[] {
		const s = this.#rooms.get(roomId);
		const me = s?.sockets.find((x) => x.key === key);
		if (!s || !me?.tvId) return [];
		return this.#diff(s, () => {
			this.#setHolder(roomId, s, me.tvId!);
			s.holderSocket = key;
			s.goneSince = null;
		});
	}

	/** Called on a timer: promotes a copy (or frees the seat) once the holder's grace has run out. */
	sweep(): { roomId: string; notices: SeatNotice[] }[] {
		const out: { roomId: string; notices: SeatNotice[] }[] = [];
		for (const [roomId, s] of this.#rooms) {
			const notices = this.#diff(s, () => this.#expire(roomId, s));
			if (notices.length) out.push({ roomId, notices });
		}
		return out;
	}

	/** Whether this socket's telemetry may move the room. */
	holds(roomId: string, key: number): boolean {
		return this.#rooms.get(roomId)?.holderSocket === key;
	}
}
