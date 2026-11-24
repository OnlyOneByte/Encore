// The room's screens, for the host's Screens page (proposal 34): every `/tv` open in a room, its name, whether it is
// the TV, and how far a copy runs from the TV's clock. See docs/SERVER.md#screens.

import { MAX_TV_SCREENS } from '../../contract';
import type { ScreenRow as ScreenView } from '../../screens';

export const SCREEN_NAME_MAX = 32;
/** A copy's drift report older than this is not shown: it has stopped following (its TV dropped, or it paused). */
export const DRIFT_FRESH_MS = 10_000;
/** A screen opened this recently that nobody has named yet is the page's new arrival. */
export const NEW_SCREEN_MS = 60_000;
/** A drift past this is not a measurement; the copy is lost and will seek. */
const DRIFT_MAX_MS = 60_000;

type Socket = { key: number; screenId: string; tvId?: string; openedAt: number; driftMs?: number; driftAt?: number };
type Room = { sockets: Socket[]; names: Map<string, string>; numbers: Map<string, number>; next: number };

/** Trim, fold whitespace and drop control characters; null when nothing is left. */
export function cleanScreenName(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const name = raw
		// eslint-disable-next-line no-control-regex -- stripping control characters is the point
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, SCREEN_NAME_MAX)
		.trim();
	return name || null;
}

export class TvScreens {
	#rooms = new Map<string, Room>();
	#now: () => number;
	constructor(now: () => number) {
		this.#now = now;
	}

	#room(roomId: string): Room {
		let r = this.#rooms.get(roomId);
		if (!r) this.#rooms.set(roomId, (r = { sockets: [], names: new Map(), numbers: new Map(), next: 1 }));
		return r;
	}

	/** Whether a new screen would be one too many. A screen already open (another tab, a reload) is never "new". */
	isFull(roomId: string, tvId: string | undefined): boolean {
		const r = this.#rooms.get(roomId);
		if (!r) return false;
		if (tvId && r.sockets.some((s) => s.tvId === tvId)) return false;
		return new Set(r.sockets.map((s) => s.screenId)).size >= MAX_TV_SCREENS;
	}

	connect(roomId: string, key: number, tvId: string | undefined): void {
		const r = this.#room(roomId);
		const screenId = tvId ?? `s${key}`;
		r.sockets.push({ key, screenId, tvId, openedAt: this.#now() });
		if (!r.numbers.has(screenId)) r.numbers.set(screenId, r.next++);
	}

	disconnect(roomId: string, key: number): void {
		const r = this.#rooms.get(roomId);
		if (!r) return;
		const gone = r.sockets.find((s) => s.key === key);
		r.sockets = r.sockets.filter((s) => s.key !== key);
		// A cookieless screen is its socket: nothing can bring it back, so its number goes with it.
		if (gone && !gone.tvId) r.numbers.delete(gone.screenId);
	}

	/** A copy's own measure of its distance from the TV's clock. Ignored unless it is a finite number. */
	drift(roomId: string, key: number, ms: unknown): void {
		if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
		const s = this.#rooms.get(roomId)?.sockets.find((x) => x.key === key);
		if (!s) return;
		s.driftMs = Math.round(Math.max(-DRIFT_MAX_MS, Math.min(DRIFT_MAX_MS, ms)));
		s.driftAt = this.#now();
	}

	/** False when no such screen is open. */
	rename(roomId: string, screenId: string, name: string): boolean {
		const r = this.#rooms.get(roomId);
		if (!r?.sockets.some((s) => s.screenId === screenId)) return false;
		r.names.set(screenId, name);
		return true;
	}

	/** A removed screen loses its name and number; opened again, it arrives as a new screen. Not a ban. */
	forget(roomId: string, screenId: string): void {
		const r = this.#rooms.get(roomId);
		r?.names.delete(screenId);
		r?.numbers.delete(screenId);
	}

	/** The screen's live sockets, oldest first. */
	socketsOf(roomId: string, screenId: string): number[] {
		return (this.#rooms.get(roomId)?.sockets ?? []).filter((s) => s.screenId === screenId).map((s) => s.key);
	}

	/** The TV first, then the others in the order they first opened. `tvKey` is the seat's live socket, if any. */
	list(roomId: string, tvKey: number | null): ScreenView[] {
		const r = this.#rooms.get(roomId);
		if (!r) return [];
		const now = this.#now();
		const views = new Map<string, ScreenView & { n: number }>();
		for (const s of r.sockets) {
			const v = views.get(s.screenId) ?? {
				id: s.screenId,
				name: r.names.get(s.screenId) ?? `Screen ${r.numbers.get(s.screenId) ?? r.next}`,
				isTv: false,
				driftMs: null,
				isNew: !r.names.has(s.screenId),
				canBeTv: !!s.tvId,
				n: r.numbers.get(s.screenId) ?? Infinity
			};
			if (s.key === tvKey) v.isTv = true;
			// The screen's newest socket speaks for it: the oldest opening counts for "new", the latest report for drift.
			v.isNew &&= now - s.openedAt < NEW_SCREEN_MS;
			if (s.driftAt !== undefined && now - s.driftAt < DRIFT_FRESH_MS) v.driftMs = s.driftMs ?? null;
			views.set(s.screenId, v);
		}
		return [...views.values()]
			.map((v) => ({ ...v, driftMs: v.isTv ? null : v.driftMs, isNew: v.isNew && !v.isTv }))
			.sort((a, b) => Number(b.isTv) - Number(a.isTv) || a.n - b.n)
			.map(({ n: _n, ...v }) => v);
	}
}

/** What server.ts, which owns the sockets and the seat, lets the Screens API do. */
export interface ScreensControl {
	list(): ScreenView[];
	/** Whether a song is current: a screen becomes the TV mid-song only when tapped (owner ruling, proposal 34). */
	midSong(): boolean;
	rename(screenId: string, name: string): boolean;
	remove(screenId: string): 'ok' | 'unknown' | 'is-tv';
	makeTv(screenId: string): 'ok' | 'unknown' | 'mid-song' | 'no-cookie';
}
