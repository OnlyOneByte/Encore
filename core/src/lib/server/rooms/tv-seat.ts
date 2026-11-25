// One TV per room: which `role=tv` socket is THE TV, the one whose telemetry moves the room. A screen is named by
// its `encore_tv` cookie (minted by GET /tv), not by anything on the WS URL, so a guest reading along on their phone
// or a forgotten laptop tab is a copy that cannot end the song or move the playhead. It identifies a screen; it is
// not a password, and the README's trusted-LAN line is unchanged. See docs/SERVER.md#the-tv-seat.

import { createHash } from 'node:crypto';

export const TV_COOKIE = 'encore_tv';

/** How long a seat waits for its screen after that screen's last socket closes (a reload, a wifi blip, a reboot). */
export const TV_SEAT_GRACE_MS = 15_000;

/** The slow-boot guard. After a core restart a saved holder gets this long, not the grace, since a TV boots slower
 *  than a phone tab reconnects. And no copy is promoted while the holder's cookie connected within this window, so
 *  a TV that flaps on and off while it boots keeps its seat. A copy can still `tv:claim` at any time. */
export const TV_SEAT_SLOW_BOOT_MS = 60_000;

/** The minted cookie is `mintSessionToken()`: 24 random bytes, base64url, so exactly 32 URL-safe characters. */
const TV_COOKIE_SHAPE = /^[A-Za-z0-9_-]{32}$/;

/**
 * Read the screen's cookie value out of a Cookie header, or undefined when absent or not one we could have minted.
 * FIXATION IS HARMLESS HERE, BY DESIGN: only the shape is checked, so a planted or known value (cookies are not
 * port-scoped) is "the same screen" as its holder. That buys nothing a `tv:claim` does not already give any LAN
 * device under the owner's no-lockout rule. The seat is an identity, never an auth gate.
 */
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

/** A socket's new answer to "am I the TV?, and is the TV here?", for `tv:seat`. `tvOnline`: the seat's screen has a
 *  live socket, so a copy can say "The TV is reconnecting..." instead of pointing at a screen that is gone. `next`:
 *  this is the room's TV, back mid-song, and it takes the seat at the next song. */
export type SeatNotice = { key: number; mine: boolean; tvOnline: boolean; next: boolean };

type Seat = {
	/** The screen that holds the seat, or null when it is free. Persisted, so a core restart hands it back. */
	holder: string | null;
	/** The room's TV: the screen that last took the seat by choice (a free seat, a claim), not by standing in for a
	 *  screen gone past its wait. Coming back, it takes the seat back.
	 *  shortcut: kept in memory, so after a core restart the saved holder is the room's TV; persist it if a stand-in
	 *  across a restart ever matters. */
	roomTv: string | null;
	/** That screen's live socket: the newest one, so a reload's new socket takes over before the old one closes. */
	holderSocket: number | null;
	/** When the holder's last socket closed (or, after a restart, when the room was first seen), else null. */
	goneSince: number | null;
	/** How long the holder may be gone before a copy is promoted: the grace, or the slow-boot window after a restart. */
	graceMs: number;
	/** When the holder's cookie last connected (or took the seat), else null. See {@link TV_SEAT_SLOW_BOOT_MS}. */
	holderSeenAt: number | null;
	/** Every live TV socket of the room, oldest first. A cookieless one has no tvId and can never hold the seat. */
	sockets: { key: number; tvId?: string }[];
};

export interface TvSeatStore {
	/** The persisted holder of a room's seat, read once when the room is first seen. */
	load(roomId: string): string | null;
	save(roomId: string, holder: string | null): void;
	now(): number;
	/** Run `run` once, `ms` from now (the server's timer, a test's fake clock). */
	schedule(ms: number, run: () => void): void;
	/** Deliver what a timed sweep decided, the same way the caller delivers a connect's or a close's notices. */
	announce(notices: SeatNotice[]): void;
	/** Whether a song is current: the room's TV back mid-song waits for the next song (owner ruling, proposal 34). */
	midSong(): boolean;
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
			// After a restart the holder has no socket yet: it gets the slow-boot window, counted from now.
			s = {
				holder,
				roomTv: holder,
				holderSocket: null,
				goneSince: holder ? this.#store.now() : null,
				graceMs: holder ? TV_SEAT_SLOW_BOOT_MS : TV_SEAT_GRACE_MS,
				holderSeenAt: null,
				sockets: []
			};
			this.#rooms.set(roomId, s);
		}
		return s;
	}

	#setHolder(roomId: string, s: Seat, holder: string | null): void {
		if (s.holder !== holder) this.#store.save(roomId, holder);
		s.holder = holder;
	}

	/** The holder's screen is here now, on `key` (it connected, was promoted, or claimed). */
	#seated(s: Seat, key: number): void {
		s.holderSocket = key;
		s.goneSince = null;
		s.graceMs = TV_SEAT_GRACE_MS;
		s.holderSeenAt = this.#store.now();
	}

	/** Runs `change` and returns a notice for each socket whose answer (`mine` or `tvOnline`) moved. A new socket is not
	 *  in `before`, so it is always told. Every `mine: false` comes FIRST: the caller sends in this order, so on a seat
	 *  move the old TV is told to go silent before the new one is told to play, never the other way round (the audio
	 *  is sacred). */
	#diff(s: Seat, change: () => void): SeatNotice[] {
		const waiting = () => (s.holder !== s.roomTv && s.holderSocket !== null ? this.#roomTvSocket(s) : null);
		const answer = (key: number, w: number | null): SeatNotice => ({
			key,
			mine: key === s.holderSocket,
			tvOnline: s.holderSocket !== null,
			next: key === w
		});
		const w0 = waiting();
		const before = new Map(s.sockets.map((x) => [x.key, answer(x.key, w0)]));
		change();
		const w1 = waiting();
		const moved = s.sockets
			.map((x) => answer(x.key, w1))
			.filter((n) => {
				const was = before.get(n.key);
				return was?.mine !== n.mine || was.tvOnline !== n.tvOnline || was.next !== n.next;
			});
		return [...moved.filter((n) => !n.mine), ...moved.filter((n) => n.mine)];
	}

	/** The room's TV's newest live socket, or null when it is not open. */
	#roomTvSocket(s: Seat): number | null {
		return s.roomTv === null ? null : (s.sockets.findLast((x) => x.tvId === s.roomTv)?.key ?? null);
	}

	/** The room's TV, open, takes the seat from a screen standing in for it. False when it is not open. */
	#reclaim(roomId: string, s: Seat): boolean {
		const key = this.#roomTvSocket(s);
		if (key === null) return false;
		this.#setHolder(roomId, s, s.roomTv);
		this.#seated(s, key);
		return true;
	}

	/** How long until the seat stops waiting for its holder (0 or less: it has stopped), or null when it is not waiting. */
	#left(s: Seat): number | null {
		if (s.holderSocket !== null || s.goneSince === null) return null;
		const now = this.#store.now();
		const boot = s.holderSeenAt === null ? 0 : s.holderSeenAt + TV_SEAT_SLOW_BOOT_MS - now;
		return Math.max(s.goneSince + s.graceMs - now, boot);
	}

	/** The holder has been gone past the grace: the newest screen with a cookie stands in, or the seat goes free. */
	#expire(roomId: string, s: Seat): void {
		const left = this.#left(s);
		if (left === null || left > 0 || this.#reclaim(roomId, s)) return;
		const next = s.sockets.findLast((x) => x.tvId);
		this.#setHolder(roomId, s, next?.tvId ?? null);
		if (next) this.#seated(s, next.key);
		else s.goneSince = null;
	}

	/** Every connect, close and claim can start (or move) a holder's wait, and that wait ends at most 15 s (the grace)
	 *  or 60 s (the slow-boot window) after it, so each one books a sweep at both. */
	#book(): void {
		for (const ms of [TV_SEAT_GRACE_MS, TV_SEAT_SLOW_BOOT_MS]) this.#sweepIn(ms);
	}

	/** A timed sweep. Bun's timer can fire a millisecond before `now()` has moved `ms` (measured: 11 of 40 at 15 s), and
	 *  that sweep finds the wait not quite over. So any sweep that leaves a wait running books another for what is left
	 *  (at least 1 ms, so a wait that came due between the sweep and this read still gets one), rather than dropping
	 *  the promotion until some unrelated connect.
	 *  shortcut: the re-book is global across rooms (the soonest wait of any room) and chains are not deduplicated, so
	 *  each booked sweep that finds a wait running keeps its own chain until no room waits. Fine for a few rooms; key
	 *  a single timer by deadline if a box ever serves many. */
	#sweepIn(ms: number): void {
		this.#store.schedule(ms, () => {
			for (const r of this.sweep()) this.#store.announce(r.notices);
			let next = Infinity;
			for (const s of this.#rooms.values()) next = Math.min(next, this.#left(s) ?? Infinity);
			if (next !== Infinity) this.#sweepIn(Math.max(next, 1));
		});
	}

	connect(roomId: string, key: number, tvId: string | undefined): SeatNotice[] {
		const s = this.#seat(roomId);
		this.#book();
		return this.#diff(s, () => {
			this.#expire(roomId, s);
			s.sockets.push({ key, tvId });
			if (!tvId) return;
			if (s.holder === null) {
				this.#setHolder(roomId, s, tvId);
				s.roomTv ??= tvId;
			}
			// The room's TV back while a screen stands in for it plays again at once, unless the stand-in is playing a
			// song: then the TV waits for the next song (`boundary`), as a screen becomes the TV mid-song only when tapped.
			if (tvId === s.roomTv && (s.holderSocket === null || !this.#store.midSong())) this.#setHolder(roomId, s, tvId);
			if (tvId === s.holder) this.#seated(s, key);
		});
	}

	/** A song ended or started: the room's TV, back while a screen stood in for it, takes the seat now. */
	boundary(roomId: string): SeatNotice[] {
		const s = this.#rooms.get(roomId);
		if (!s || s.holder === s.roomTv || this.#roomTvSocket(s) === null) return [];
		return this.#diff(s, () => this.#reclaim(roomId, s));
	}

	/** The host removed `tvId`. When it was standing in for the room's TV, that TV takes the seat if it is open, or
	 *  the seat waits the grace for it (after which the next screen stands in). The room's TV is never removed. */
	release(roomId: string, tvId: string): SeatNotice[] {
		const s = this.#rooms.get(roomId);
		if (!s || s.holder !== tvId || tvId === s.roomTv) return [];
		this.#book();
		return this.#diff(s, () => {
			if (this.#reclaim(roomId, s)) return;
			this.#setHolder(roomId, s, s.roomTv);
			s.holderSocket = null;
			s.goneSince = this.#store.now();
			s.graceMs = TV_SEAT_GRACE_MS;
			s.holderSeenAt = null;
		});
	}

	/** The room's TV (see {@link Seat.roomTv}), or null before any screen took the seat. */
	roomTv(roomId: string): string | null {
		return this.#rooms.get(roomId)?.roomTv ?? null;
	}

	disconnect(roomId: string, key: number): SeatNotice[] {
		const s = this.#rooms.get(roomId);
		if (!s) return [];
		this.#book();
		return this.#diff(s, () => {
			s.sockets = s.sockets.filter((x) => x.key !== key);
			if (s.holderSocket !== key) return;
			// Another tab of the same screen carries on; otherwise the seat waits out the grace for this screen.
			s.holderSocket = s.sockets.findLast((x) => x.tvId === s.holder)?.key ?? null;
			if (s.holderSocket !== null) return;
			// A stand-in gone while the room's TV waits for the next song: nothing plays now, so the TV takes it.
			if (s.holder !== s.roomTv && this.#reclaim(roomId, s)) return;
			s.goneSince = this.#store.now();
		});
	}

	/** "Make this the TV": the claiming screen takes the seat at once and the old holder becomes a copy. */
	claim(roomId: string, key: number): SeatNotice[] {
		const s = this.#rooms.get(roomId);
		const me = s?.sockets.find((x) => x.key === key);
		if (!s || !me?.tvId) return [];
		// A claim by the socket that already holds the seat moves nothing, so it books nothing: a client looping on
		// "Make this the TV" must not pile up timers.
		if (s.holderSocket === key) return [];
		this.#book();
		return this.#diff(s, () => {
			this.#setHolder(roomId, s, me.tvId!);
			s.roomTv = me.tvId!;
			this.#seated(s, key);
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

	/** The seat's live socket, or null while it has none. */
	holderKey(roomId: string): number | null {
		return this.#rooms.get(roomId)?.holderSocket ?? null;
	}

	/** Whether the seat's screen has a live socket: THE TV, the one that can play a song, fail it and release a hold.
	 *  A copy alone does not count, since its frames are dropped and it could never report a song that won't play. */
	hasLiveHolder(roomId: string): boolean {
		return (this.#rooms.get(roomId)?.holderSocket ?? null) !== null;
	}
}
