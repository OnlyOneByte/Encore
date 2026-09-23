// Join logic — pure-ish handler so it unit-tests without HTTP. The +server.ts route is a thin
// wrapper that parses the request, calls this, sets the session cookie, and returns JSON.

import { normalizeSingerColor, graceMsOf, type Singer } from '../../contract';
import type { EncoreApp } from '../app';

export interface JoinInput {
	displayName: string;
	color: string;
	/** Room join code (TV QR or typed). Absent = the core's single active room ({@link EncoreApp.activeRoomId}); present = that room specifically — an unknown code is refused, never silently defaulted, so a mistyped code can't drop a guest into the wrong party. */
	code?: string;
}

export interface JoinResult {
	singer: Singer;
	/** The room this join landed in — the room identity the session then carries. */
	roomId: string;
}

/** Thrown when the requested display name is already held by someone still in the room. The message IS guest copy — `/api/join` returns it as `error` and JoinLanding renders it verbatim into `.err[role=alert]`, so it must read as a sentence with a next step, not developer text. `takenName` stays for callers and logs. */
export class NameTakenError extends Error {
	// NOT a field called `name` — Error already owns that, and shadowing it makes the thrown error
	// stringify as the singer's name instead of its type.
	readonly takenName: string;
	constructor(takenName: string) {
		super('That name is taken — try another.');
		this.takenName = takenName;
	}
}

/** Thrown when a join names a room code that resolves to no room. Same wording as `/api/room-preview`'s 404 (both shown verbatim to a guest on the same screen) so there's one sentence for one failure, not two spellings of it. */
export class RoomNotFoundError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`No room is using the code ${code}.`);
		this.code = code;
	}
}

/** Case- and whitespace-insensitive, because "dana" and "Dana " are the same person to everyone else. */
export const nameKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** Codes are minted uppercase (see RoomRepository's CODE_ALPHABET), but a guest types one off a TV, so accept any case and surrounding whitespace and canonicalise to the stored form before lookup. */
export const normalizeRoomCode = (code: string): string => code.trim().toUpperCase();

/** A public singer — what `listPublic` projects onto the wire (no session token, no roomId). */
type Member = Omit<Singer, 'sessionToken'>;

/**
 * WHO IS STILL IN THIS ROOM, split by whether their phone is reachable. `assertNameFree` refuses a name held by anyone not `gone` (here OR away) — the grace window's whole point is that a locked phone doesn't hand your name to the next guest. Read ONCE here so both `assertNameFree` and /api/room-preview derive from the same membership; deriving it twice let them disagree about who was in the room. `here` first in the returned lists so a caller naming only a few people names reachable ones first.
 */
export function roomMembership(app: EncoreApp, roomId: string): { here: Member[]; away: Member[] } {
	const graceMs = graceMsOf(app.settings.getRoom(roomId).presenceGraceMinutes);
	const now = app.now();
	const online = new Set(app.presence.online());
	const here: Member[] = [];
	const away: Member[] = [];
	for (const s of app.singers.listPublic(roomId)) {
		if (online.has(s.id)) {
			here.push(s);
			continue;
		}
		// Not connected: still in the room only while the grace clock is running, or while holding a
		// turn (which keeps that clock unstarted) — exactly the test `assertNameFree` applies.
		if (app.presence.stateOf(s.id, now, graceMs, hasPendingSongs(app, s.id)) !== 'gone') away.push(s);
	}
	return { here, away };
}

/**
 * Refuse a name already held by someone still IN THE ROOM — scoped to membership, not the table: `singers` is append-only and file-backed, so an unqualified unique check would claim a name FOREVER. Checking membership returns the name to the pool once its owner is actually gone, and holds it through the grace window otherwise. `roomId` scopes to ONE party (two rooms can each have a Dana); `exceptId` is for a RENAME, so a singer changing capitalisation doesn't collide with themselves.
 */
export function assertNameFree(app: EncoreApp, roomId: string, name: string, exceptId?: string): void {
	const key = nameKey(name);
	// Through `roomMembership`, not re-derived, so the set this refuses from IS the set /api/room-preview describes.
	const { here, away } = roomMembership(app, roomId);
	const clash = [...here, ...away].some((s) => s.id !== exceptId && nameKey(s.displayName) === key);
	if (clash) throw new NameTakenError(name);
}

/** Whether this singer still holds a turn — the thing that keeps their grace clock unstarted. */
export function hasPendingSongs(app: EncoreApp, singerId: string): boolean {
	return app.state.entries.some((e) => e.singerId === singerId && (e.status === 'queued' || e.status === 'playing'));
}

/** Validate + create a singer, then broadcast singer:joined. Throws on invalid input. */
export function doJoin(app: EncoreApp, input: JoinInput): JoinResult {
	// Resolve WHICH room this join lands in first — a bad code fails before we create a singer, so a
	// mistyped code never leaves an orphaned row behind. Absent code means the single active room.
	const rawCode = (input.code ?? '').trim();
	let room;
	if (rawCode) {
		room = app.rooms.byCode(normalizeRoomCode(rawCode));
		if (!room) throw new RoomNotFoundError(rawCode);
	} else {
		room = app.rooms.byId(app.activeRoomId);
		// The active room is minted at boot, so this is a should-never-happen guard rather than a path.
		if (!room) throw new Error('no active room');
	}

	const name = (input.displayName ?? '').trim();
	if (!name) throw new Error('display name required');
	// In-room uniqueness: a name is free if no one still in THIS room holds it.
	assertNameFree(app, room.id, name);
	const color = normalizeSingerColor(input.color);

	const singer = app.singers.create(name, color, app.now(), room.id);

	// Register the new singer with presence RIGHT NOW (connect then disconnect → an away-ish state), so
	// their name is held through the gap between this HTTP response and their WebSocket actually
	// opening — without lying about a live socket. Composes correctly downstream: the real WS `connect`
	// promotes them to here, an explicit `leave` frees the name immediately, and the grace sweep
	// expires them to gone on its own if the socket never comes. A rehydrated singer from a prior
	// process never runs this, so it stays gone and reclaimable.
	app.presence.connect(singer.id);
	app.presence.disconnect(singer.id, app.now());

	// SECURITY: this broadcast reaches every socket in the room, including a cookie-less spectator that
	// never joined. `singer` carries the session token — the whole auth axis (bySessionToken resolves
	// identity) — so it MUST be stripped before the wire, same as api/join, api/me, and settings already do.
	const { sessionToken: _t, ...publicSinger } = singer;
	app.publish({ type: 'singer:joined', singer: publicSinger });
	return { singer, roomId: room.id };
}
