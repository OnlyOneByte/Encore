// Keep me, the returning phone, sign out other phones and delete me. See docs/SERVER.md#kept-people.

import type { Cookies } from '@sveltejs/kit';
import type { EncoreApp } from '../app';
import { publicOriginIsHttps } from '../public-origin';
import { SESSION_COOKIE, type StoredSinger } from '../singers/repository';
import {
	DEVICE_COOKIE,
	DEVICE_COOKIE_MAX_AGE_S,
	DEVICE_COOKIE_SECURE,
	type KeptDevice,
	type Person
} from './repository';

type Req = { request: Request; url: URL };

function cookieName({ request, url }: Req): string {
	return publicOriginIsHttps(request, url) ? DEVICE_COOKIE_SECURE : DEVICE_COOKIE;
}

/** The kept person on this phone, read only from the device cookie, never from the URL or body. A phone still on
 *  the token before a rotation (its response was lost, or another tab) is sent the current one again. */
export function readDevice(app: EncoreApp, cookies: Pick<Cookies, 'get' | 'set'>, req: Req): KeptDevice | null {
	const device = app.people.byDevice(cookies.get(cookieName(req)), app.now());
	if (device?.viaGrace) setDeviceCookie(cookies, device.token, req);
	return device;
}

/** Rotate on a use of the current token; a grace use already holds the current one, so rotating again would
 *  strand the tab or response that has it. */
export function rotateDevice(app: EncoreApp, cookies: Pick<Cookies, 'set'>, device: KeptDevice, req: Req): void {
	if (!device.viaGrace) setDeviceCookie(cookies, app.people.rotate(device.deviceId, device.token, app.now()), req);
}

/** The caller of a kept-only route: tonight's singer AND this phone's device, naming the same person. */
export function keptCaller(
	app: EncoreApp,
	cookies: Pick<Cookies, 'get' | 'set'>,
	req: Req
): { me: StoredSinger; device: KeptDevice } | null {
	const me = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	const device = readDevice(app, cookies, req);
	return me && device && me.personId === device.person.id ? { me, device } : null;
}

export function setDeviceCookie(cookies: Pick<Cookies, 'set'>, token: string, req: Req): void {
	const secure = publicOriginIsHttps(req.request, req.url);
	cookies.set(cookieName(req), token, {
		path: '/',
		httpOnly: true,
		// Lax, not Strict: the QR opens Encore from the camera, a cross-site navigation that must still carry it.
		sameSite: 'lax',
		secure,
		maxAge: DEVICE_COOKIE_MAX_AGE_S
	});
}

export function clearDeviceCookie(cookies: Pick<Cookies, 'delete'>, req: Req): void {
	cookies.delete(cookieName(req), { path: '/', secure: publicOriginIsHttps(req.request, req.url) });
}

/** What the You tab offers this singer. Never before their first song, and never on a phone kept for someone else. */
export function keepState(singer: StoredSinger, device: KeptDevice | null, app: EncoreApp) {
	const kept = device !== null && singer.personId === device.person.id;
	return {
		kept,
		canKeep: !kept && device === null && singer.personId === null && singer.lastSungAt != null,
		otherPhones: kept ? app.people.otherDeviceCount(device.person.id, device.deviceId) : 0
	};
}

/** Keep tonight's singer: a new person, a new device token and a fresh singer token. The caller checks `canKeep`. */
export function keepSinger(
	app: EncoreApp,
	singer: StoredSinger
): { person: Person; deviceToken: string; singerToken: string } {
	const { person, token } = app.people.create(singer.displayName, singer.color, app.now());
	const singerToken = app.singers.linkPerson(singer.id, person.id);
	return { person, deviceToken: token, singerToken };
}

/** End every other night of this person that is still signed in, so a lost phone stops acting as them. */
function endOtherSessions(app: EncoreApp, personId: string, exceptSingerId: string): void {
	for (const s of app.singers.byPerson(personId)) {
		if (s.id === exceptSingerId) continue;
		app.singers.endSession(s.id);
		app.releaseSinger?.(s.id);
	}
}

/** Every other device goes, and this one gets a new token, since a copy of its cookie is the same row. */
export function signOutOtherPhones(app: EncoreApp, device: KeptDevice, singerId: string): void {
	app.people.signOutOthers(device.person.id, device.deviceId);
	endOtherSessions(app, device.person.id, singerId);
}

export const PERSON_PRUNE_EVERY_MS = 86_400_000;

/** Delete every person whose phones have all gone idle; they can never come back. */
export function pruneIdlePeople(app: EncoreApp): void {
	for (const personId of app.people.pruneIdle(app.now())) forgetPerson(app, personId);
}

/** For a periodic tick: the prune at most once a day, the first a day after `since` (boot runs its own). */
export function dailyPersonPrune(app: EncoreApp, since: number): () => void {
	let last = since;
	return () => {
		if (app.now() - last < PERSON_PRUNE_EVERY_MS) return;
		last = app.now();
		pruneIdlePeople(app);
	};
}

/** Delete me: the person, every device and every past night. `keepSingerId` stays in the room tonight as a guest;
 *  a night still holding a turn is unlinked rather than deleted, so the queue keeps its singer. */
export function forgetPerson(app: EncoreApp, personId: string, keepSingerId: string | null = null): void {
	endOtherSessions(app, personId, keepSingerId ?? '');
	const holding = new Set(app.state.entries.map((e) => e.singerId));
	for (const s of app.singers.byPerson(personId)) {
		if (s.id === keepSingerId || holding.has(s.id)) app.singers.unlinkPerson(s.id);
		else app.singers.delete(s.id);
	}
	app.people.delete(personId);
}
