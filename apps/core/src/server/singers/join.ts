// Join logic — pure-ish handler so it unit-tests without HTTP. The +server.ts route is a thin
// wrapper that parses the request, calls this, sets the session cookie, and returns JSON.

import { normalizeSingerColor, graceMsOf, type Singer } from '@encore/shared';
import type { EncoreApp } from '../app';

export interface JoinInput {
	displayName: string;
	color: string;
}

export interface JoinResult {
	singer: Singer;
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

/** Case- and whitespace-insensitive, because "dana" and "Dana " are the same person to everyone else. */
export const nameKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Refuse a name already held by someone still IN THE ROOM.
 *
 * Scoping to membership rather than to the table is the whole subtlety: `singers` is append-only and
 * file-backed, so an unqualified unique check would claim a name FOREVER and next month's Dana would be
 * refused by a ghost row from tonight. Checking membership means the name returns to the pool once its
 * owner has actually gone, and stays claimed through the grace window so nobody takes it while she is in
 * the bathroom.
 *
 * `exceptId` is for a RENAME: a singer changing their capitalisation must not collide with themselves.
 */
export function assertNameFree(app: EncoreApp, name: string, exceptId?: string): void {
	const key = nameKey(name);
	const graceMs = graceMsOf(app.settings.getRoom().presenceGraceMinutes);
	const clash = app.singers.listPublic().some((s) => {
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
	const name = (input.displayName ?? '').trim();
	if (!name) throw new Error('display name required');
	assertNameFree(app, name);
	/*
	 * Was `isValidColor(input.color) ? input.color : SINGER_COLORS[0]` — an allowlist of the eight
	 * presets, so every other hue was silently rewritten to violet and a guest who picked teal joined
	 * as violet with nothing said. normalizeSingerColor accepts any hex whose dot stays visible and
	 * canonicalises it, falling back to a preset only for input that is genuinely unusable.
	 */
	const color = normalizeSingerColor(input.color);

	const singer = app.singers.create(name, color, app.now());

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

	app.publish({ type: 'singer:joined', singer });
	return { singer };
}
