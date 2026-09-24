// A pure-ish handler so it unit-tests without HTTP; the route is a thin wrapper around it.

import { normalizeSingerColor, graceMsOf, type Singer } from '../../contract';
import type { EncoreApp } from '../app';
import type { Room } from '../rooms/repository';

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
	// NOT called `name`: Error owns that, and shadowing it stringifies the error as the singer's name.
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
const nameKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** Codes are minted uppercase (see RoomRepository's CODE_ALPHABET), but a guest types one off a TV, so accept any case and surrounding whitespace and canonicalise to the stored form before lookup. */
const normalizeRoomCode = (code: string): string => code.trim().toUpperCase();

/** What `listPublic` projects onto the wire: no session token, no roomId. */
type Member = Omit<Singer, 'sessionToken'>;

/**
 * Split by whether the phone is reachable. `assertNameFree` refuses a name held by anyone not `gone` — the
 * grace window's point is that a locked phone does not hand your name to the next guest. Read ONCE here so
 * `assertNameFree` and /api/room-preview cannot disagree about who is in the room; `here` comes first, so a
 * caller naming only a few people names reachable ones first.
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
		// Not connected: in the room only while the grace clock runs, or while holding a turn.
		if (app.presence.stateOf(s.id, now, graceMs, hasPendingSongs(app, s.id)) !== 'gone') away.push(s);
	}
	return { here, away };
}

/**
 * Scoped to MEMBERSHIP, not the table: `singers` is append-only and file-backed, so an unqualified unique
 * check claims a name FOREVER. Membership returns the name to the pool once its owner is gone and holds it
 * through the grace window otherwise. `exceptId` is for a RENAME, so a re-capitalisation does not self-collide.
 */
export function assertNameFree(app: EncoreApp, roomId: string, name: string, exceptId?: string): void {
	const key = nameKey(name);
	// Through `roomMembership`, so the set this refuses from IS the set /api/room-preview describes.
	const { here, away } = roomMembership(app, roomId);
	const clash = [...here, ...away].some((s) => s.id !== exceptId && nameKey(s.displayName) === key);
	if (clash) throw new NameTakenError(name);
}

/** Whether this singer still holds a turn — the thing that keeps their grace clock unstarted. */
export function hasPendingSongs(app: EncoreApp, singerId: string): boolean {
	return app.state.entries.some((e) => e.singerId === singerId && (e.status === 'queued' || e.status === 'playing'));
}

/** An explicit code names one room and an unknown one is REFUSED, never silently defaulted; no code lands
 *  in the active room. Resolved before anything is created, so a bad code leaves no orphaned singer row. */
function resolveJoinRoom(app: EncoreApp, rawCode: string): Room {
	if (rawCode) {
		const room = app.rooms.byCode(normalizeRoomCode(rawCode));
		if (!room) throw new RoomNotFoundError(rawCode);
		return room;
	}
	const room = app.rooms.byId(app.activeRoomId);
	// The active room is minted at boot, so this is a guard rather than a path.
	if (!room) throw new Error('no active room');
	return room;
}

/** Validate + create a singer, then broadcast singer:joined. Throws on invalid input. */
export function doJoin(app: EncoreApp, input: JoinInput): JoinResult {
	const room = resolveJoinRoom(app, (input.code ?? '').trim());

	const name = (input.displayName ?? '').trim();
	if (!name) throw new Error('display name required');
	// In-room uniqueness: a name is free if no one still in THIS room holds it.
	assertNameFree(app, room.id, name);
	const color = normalizeSingerColor(input.color);

	const singer = app.singers.create(name, color, app.now(), room.id);

	// Registered RIGHT NOW (connect then disconnect, an away-ish state), so the name is held across the gap
	// between this HTTP response and the WebSocket opening, without claiming a live socket. The real WS
	// `connect` promotes them, an explicit `leave` frees the name, and the sweep expires them otherwise.
	app.presence.connect(singer.id);
	app.presence.disconnect(singer.id, app.now());

	// This broadcast reaches EVERY socket in the room, including a cookie-less spectator, and `singer`
	// carries the session token — the whole auth axis — so it MUST be stripped before the wire.
	const { sessionToken: _t, ...publicSinger } = singer;
	app.publish({ type: 'singer:joined', singer: publicSinger });
	return { singer, roomId: room.id };
}
