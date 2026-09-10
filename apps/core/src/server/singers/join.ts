// Join logic — pure-ish handler so it unit-tests without HTTP. The +server.ts route is a thin
// wrapper that parses the request, calls this, sets the session cookie, and returns JSON.

import { normalizeSingerColor, graceMsOf, type Singer } from '@encore/shared';
import type { EncoreApp } from '../app';

export interface JoinInput {
	displayName: string;
	color: string;
	/**
	 * The room join code (from the TV QR or typed on the phone). Absent = an unqualified join, which
	 * lands in the core's single active room ({@link EncoreApp.activeRoomId}). Present = join THAT
	 * room specifically, resolved against the rooms table; an unknown code is refused, never silently
	 * routed to the default, so a mistyped code cannot drop a guest into the wrong party.
	 */
	code?: string;
}

export interface JoinResult {
	singer: Singer;
	/** The room this join landed in — the room identity the session then carries (#654). */
	roomId: string;
}

/** Thrown when the requested display name is already held by someone still in the room. */
export class NameTakenError extends Error {
	// NOT a field called `name` — Error already owns that, and shadowing it makes the thrown error
	// stringify as the singer's name instead of its type.
	readonly takenName: string;
	constructor(takenName: string) {
		super(`the name "${takenName}" is taken`);
		this.takenName = takenName;
	}
}

/** Thrown when a join names a room code that resolves to no room — a mistyped or stale code. */
export class RoomNotFoundError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`no room with code "${code}"`);
		this.code = code;
	}
}

/** Case- and whitespace-insensitive, because "dana" and "Dana " are the same person to everyone else. */
export const nameKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Codes are minted uppercase (see RoomRepository's CODE_ALPHABET), but a guest types one off a TV,
 * so accept any case and surrounding whitespace and canonicalise to the stored form before lookup.
 */
export const normalizeRoomCode = (code: string): string => code.trim().toUpperCase();

/**
 * Refuse a name already held by someone still IN THE ROOM.
 *
 * Scoping to membership rather than to the table is the whole subtlety: `singers` is append-only and
 * file-backed, so an unqualified unique check would claim a name FOREVER and next month's Dana would be
 * refused by a ghost row from tonight. Checking membership means the name returns to the pool once its
 * owner has actually gone, and stays claimed through the grace window so nobody takes it while she is in
 * the bathroom.
 *
 * `roomId` scopes the check to ONE party (#656): a name is only taken if someone still in the SAME
 * room holds it, so two rooms can each have a Dana. `exceptId` is for a RENAME: a singer changing
 * their capitalisation must not collide with themselves.
 */
export function assertNameFree(app: EncoreApp, roomId: string, name: string, exceptId?: string): void {
	const key = nameKey(name);
	const graceMs = graceMsOf(app.settings.getRoom(roomId).presenceGraceMinutes);
	const clash = app.singers.listPublic(roomId).some((s) => {
		if (s.id === exceptId) return false;
		if (nameKey(s.displayName) !== key) return false;
		return app.presence.stateOf(s.id, app.now(), graceMs, hasPendingSongs(app, s.id)) !== 'gone';
	});
	if (clash) throw new NameTakenError(name);
}

/** Whether this singer still holds a turn — the thing that keeps their grace clock unstarted. */
export function hasPendingSongs(app: EncoreApp, singerId: string): boolean {
	return app.state.entries.some((e) => e.singerId === singerId && (e.status === 'queued' || e.status === 'playing'));
}

/** Validate + create a singer, then broadcast singer:joined. Throws on invalid input. */
export function doJoin(app: EncoreApp, input: JoinInput): JoinResult {
	// Resolve WHICH room this join lands in first — a bad code fails before we create a singer, so a
	// mistyped code never leaves an orphaned row behind. A code names a room explicitly; its absence
	// means the single active room this core minted at boot.
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
	// In-room uniqueness (#656): a name is free if no one still in THIS room holds it.
	assertNameFree(app, room.id, name);
	/*
	 * Was `isValidColor(input.color) ? input.color : SINGER_COLORS[0]` — an allowlist of the eight
	 * presets, so every other hue was silently rewritten to violet and a guest who picked teal joined
	 * as violet with nothing said. normalizeSingerColor accepts any hex whose dot stays visible and
	 * canonicalises it, falling back to a preset only for input that is genuinely unusable.
	 */
	const color = normalizeSingerColor(input.color);

	const singer = app.singers.create(name, color, app.now(), room.id);

	// Register the new singer with presence RIGHT NOW, in an away-ish state, so their name is held
	// through the gap between this HTTP response and their WebSocket actually opening. PR #19 left that
	// gap open: `create` writes the DB row, but the ONLY thing that registered a singer with the
	// PresenceTracker was the WS `open` handler — so `presence.stateOf` returned 'gone' for a singer who
	// had joined but whose socket had not landed, and a second phone could claim the identical name in
	// that window (two guests both "Dana").
	//
	// Seeding as away (a socket that connected then dropped) rather than here means we do not lie about a
	// live socket, and it composes correctly with everything downstream WITHOUT touching the tracker's
	// internals: the real `connect` on WS-open promotes them to here and cancels the clock; an explicit
	// `leave` (presence.forget) frees the name immediately; and the grace sweep expires them to gone on
	// its own if the socket never comes. A rehydrated singer from a prior process never went through this
	// path, so they stay gone and their name is reclaimable — the reclamation the check exists for.
	app.presence.connect(singer.id);
	app.presence.disconnect(singer.id, app.now());

	// SECURITY (#796): the broadcast reaches every socket in the room — including a cookie-less
	// spectator that never joined (server.ts upgrades it, room-scope subscribes it to the served
	// room's topic). `singer` is the full row minted WITH the session token, and that token IS the
	// whole auth axis (bySessionToken resolves who you are). Strip it before it hits the wire, the
	// same redaction api/join, api/me and settings already open-code. events.ts types this event as
	// PublicSinger so the compiler enforces the exclusion.
	const { sessionToken: _t, ...publicSinger } = singer;
	app.publish({ type: 'singer:joined', singer: publicSinger });
	return { singer, roomId: room.id };
}
