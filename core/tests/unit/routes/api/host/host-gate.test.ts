// Every host-only route refuses a guest, the TV and a cookieless caller, and the key is the one way in (#1080).
import { test, expect, afterEach } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { SingerRepository, SESSION_COOKIE } from '$lib/server/singers/repository';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { HostKey, HOST_COOKIE } from '$lib/server/host-key';
import { AuthoritativeState } from '$lib/server/state/store';
import { PresenceTracker } from '$lib/server/realtime/presence';
import { handle } from '$routes/../hooks.server';
import { POST as hostPost, DELETE as hostDelete } from '$routes/api/host/+server';
import { PUT as putGlobal } from '$routes/api/settings/+server';
import { PUT as putRoom } from '$routes/api/settings/room/+server';
import { POST as deleteMedia } from '$routes/api/delete-media/+server';
import { POST as leave } from '$routes/api/leave/+server';
import { GET as getAudit } from '$routes/api/audit/[mediaId]/+server';
import { GET as getMetrics } from '$routes/api/metrics/+server';
import { POST as reselect } from '$routes/api/lyrics-reselect/+server';
import { POST as rename } from '$routes/api/library/manage/rename/+server';
import { POST as keep } from '$routes/api/library/manage/keep/+server';
import { POST as libraryDelete } from '$routes/api/library/manage/delete/+server';
import { POST as undoDelete } from '$routes/api/library/manage/undo/+server';
import { GET as getSizes } from '$routes/api/library/sizes/+server';
import { AttemptLedger } from '$lib/server/jobs/attempts';
import { MediaRepository } from '$lib/server/media/repository';
import { PlayLog } from '$lib/server/media/play-log';

const APP_KEY = Symbol.for('encore.app');
const KEY = 'correct-horse-battery-staple';
const ORIGIN = 'http://192.168.1.20:3000';

function installApp() {
	const db = migratedDb();
	const app = {
		db,
		singers: new SingerRepository(db),
		hostKey: new HostKey(db, KEY),
		settings: new SettingsRepository(db),
		state: new AuthoritativeState(),
		presence: new PresenceTracker(),
		activeRoomId: 'room-1',
		mediaById: new Map<string, unknown>(),
		attempts: new AttemptLedger(db),
		media: new MediaRepository(db),
		playLog: new PlayLog(db),
		publish: () => {},
		now: () => 1_700_000_000_000
	};
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = app;
	return app;
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

/** A SvelteKit cookie jar over a plain map, recording what a route set. */
function jar(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	const set: { name: string; value: string; opts: Record<string, unknown> }[] = [];
	return {
		values,
		set,
		get: (name: string) => values.get(name),
		set_(name: string, value: string, opts: Record<string, unknown>) {
			set.push({ name, value, opts });
			values.set(name, value);
		},
		delete: (name: string) => void values.delete(name)
	};
}
function event(
	path: string,
	method: string,
	cookies: ReturnType<typeof jar>,
	body?: unknown,
	headers: Record<string, string> = {},
	routeId: string | null = null
) {
	const url = new URL(path, ORIGIN);
	const request = new Request(url, {
		method,
		headers: {
			host: '192.168.1.20:3000',
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
			...headers
		},
		body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
	});
	return {
		request,
		url,
		route: { id: routeId },
		getClientAddress: () => '192.168.1.50',
		cookies: { get: cookies.get, set: cookies.set_.bind(cookies), delete: cookies.delete }
	} as never;
}

async function unlock(): Promise<ReturnType<typeof jar>> {
	const cookies = jar();
	const res = await hostPost(event('/api/host', 'POST', cookies, { key: KEY }));
	expect(res.status).toBe(200);
	return cookies;
}

test('a joined guest, the TV and a cookieless caller are refused on every host-only write', async () => {
	const app = installApp();
	const guest = app.singers.create('Ana', '#ff0000', 0, 'room-1');
	const callers = {
		guest: jar({ [SESSION_COOKIE]: guest.sessionToken }),
		// The TV carries only its seat cookie, which grants nothing.
		tv: jar({ encore_tv: 'some-screen' }),
		cookieless: jar()
	};
	for (const [who, cookies] of Object.entries(callers)) {
		const results = [
			await putGlobal(event('/api/settings', 'PUT', cookies, { joinOrigin: 'http://evil.example' })),
			await putRoom(event('/api/settings/room', 'PUT', cookies, { queueOrder: 'fcfs' })),
			await deleteMedia(event('/api/delete-media', 'POST', cookies, { mediaId: 'm1' })),
			await reselect(event('/api/lyrics-reselect', 'POST', cookies, { mediaId: 'm1', text: 'x' })),
			await hostDelete(event('/api/host', 'DELETE', cookies)),
			await rename(event('/api/library/manage/rename', 'POST', cookies, { mediaId: 'm1', title: 'x', artist: '' })),
			await keep(event('/api/library/manage/keep', 'POST', cookies, { mediaId: 'm1', keep: true })),
			await libraryDelete(event('/api/library/manage/delete', 'POST', cookies, { mediaId: 'm1' })),
			await undoDelete(event('/api/library/manage/undo', 'POST', cookies, { mediaId: 'm1' })),
			await getSizes(event('/api/library/sizes', 'GET', cookies))
		];
		expect(
			results.map((r) => r.status),
			who
		).toEqual([403, 403, 403, 403, 403, 403, 403, 403, 403, 403]);
	}
	expect(app.settings.getGlobal().joinOrigin).toBe('');
});

test('a guest presenting the guest session as the host cookie is not the host', async () => {
	const app = installApp();
	const guest = app.singers.create('Ana', '#ff0000', 0, 'room-1');
	const res = await putGlobal(
		event('/api/settings', 'PUT', jar({ [HOST_COOKIE]: guest.sessionToken }), { joinOrigin: 'http://x' })
	);
	expect(res.status).toBe(403);
});

test('the wrong key is refused and sets nothing; the right one sets a strict HttpOnly host cookie that then writes', async () => {
	installApp();
	const wrong = jar();
	expect((await hostPost(event('/api/host', 'POST', wrong, { key: 'guess' }))).status).toBe(403);
	expect(wrong.set).toHaveLength(0);

	const host = await unlock();
	expect(host.set).toHaveLength(1);
	expect(host.set[0]!.name).toBe(HOST_COOKIE);
	expect(host.set[0]!.value).not.toBe(KEY);
	expect(host.set[0]!.opts).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/' });

	const res = await putGlobal(event('/api/settings', 'PUT', host, { joinOrigin: 'http://192.168.1.20:3000' }));
	expect(res.status).toBe(200);
});

test('signing out every host phone ends the session it was sent from too', async () => {
	installApp();
	const host = await unlock();
	const other = await unlock();
	expect((await hostDelete(event('/api/host', 'DELETE', host))).status).toBe(200);
	expect((await putRoom(event('/api/settings/room', 'PUT', other, { queueOrder: 'fcfs' }))).status).toBe(403);
});

test('Leave revokes the token on the server, so a copied cookie stops resolving', async () => {
	const app = installApp();
	const ana = app.singers.create('Ana', '#ff0000', 0, 'room-1');
	const copy = ana.sessionToken;
	expect((await leave(event('/api/leave', 'POST', jar({ [SESSION_COOKIE]: copy })))).status).toBe(200);
	expect(app.singers.bySessionToken(copy)).toBeNull();
});

test('a song history is the host only; a guest gets the catalog row the song page reads', async () => {
	const app = installApp();
	app.mediaById.set('m1', { id: 'm1', title: 'Caroline' });
	const call = (cookies: ReturnType<typeof jar>) =>
		getAudit({ ...(event('/api/audit/m1', 'GET', cookies) as object), params: { mediaId: 'm1' } } as never);
	expect(Object.keys(await (await call(jar())).json())).toEqual(['media']);
	expect(Object.keys(await (await call(await unlock())).json())).toEqual(['media', 'processes', 'plays', 'hasHistory']);
});

test('the hook gates the metrics ROUTE however its path is spelled, and the route gates itself too', async () => {
	installApp();
	const resolve = async () => new Response('route ran');
	const run = (e: never) => handle({ event: e, resolve } as never);
	const host = await unlock();
	// SvelteKit matches every one of these to /api/metrics; the hook keys on that match, not the raw path.
	for (const path of ['/api/metrics', '/api/%6Detrics', '/%61pi/metrics', '/api/metric%73', '/api/metrics/']) {
		expect((await run(event(path, 'GET', jar(), undefined, {}, '/api/metrics'))).status, path).toBe(403);
		expect(await (await run(event(path, 'GET', host, undefined, {}, '/api/metrics'))).text(), path).toBe('route ran');
	}
	expect((await getMetrics(event('/api/metrics', 'GET', jar()))).status).toBe(403);
});

test('every unsafe method on every path is checked, so an encoded or unmatched path skips nothing', async () => {
	installApp();
	const resolve = async () => new Response('route ran');
	const run = (e: never) => handle({ event: e, resolve } as never);
	const host = await unlock();
	const evil = { origin: 'http://192.168.1.20:5999' };
	for (const [path, method] of [
		['/%61pi/leave', 'POST'],
		['/%61pi/delete-media', 'POST'],
		['/api/%64elete-media', 'POST'],
		['/%61pi/join', 'POST'],
		['/API/settings', 'PUT'],
		['/api%2Fsettings', 'PUT'],
		['/api/x/../host', 'DELETE'],
		['/%2561pi/leave', 'POST'],
		['/not-a-route', 'POST']
	] as const) {
		// Another port on this machine is same-site, so it carries the host's cookie: refused by Origin.
		expect((await run(event(path, method, host, { mediaId: 'm1' }, evil))).status, path).toBe(403);
		// A no-cors simple POST: a body and no Content-Type at all.
		const noType = event(path, method, host, '{"mediaId":"m1"}', { origin: ORIGIN });
		(noType as unknown as { request: Request }).request.headers.delete('content-type');
		expect((await run(noType)).status, path).toBe(415);
	}
});

test('a route refuses a body that is not application/json even without the hook', async () => {
	installApp();
	const host = await unlock();
	const req = event('/api/delete-media', 'POST', host, '{"mediaId":"m1"}');
	(req as unknown as { request: Request }).request.headers.delete('content-type');
	await expect(deleteMedia(req)).rejects.toMatchObject({ status: 415 });
	await expect(
		putGlobal(event('/api/settings', 'PUT', host, '{}', { 'content-type': 'text/plain' }))
	).rejects.toMatchObject({ status: 415 });
});

test('POST /api/host answers a null body with 400, and wrong keys never lock the right one out', async () => {
	installApp();
	expect((await hostPost(event('/api/host', 'POST', jar(), 'null'))).status).toBe(400);
	for (let i = 0; i < 20; i++)
		expect((await hostPost(event('/api/host', 'POST', jar(), { key: 'x' }))).status).toBe(403);
	// A guest behind the host's NAT cannot lock the host out.
	expect((await hostPost(event('/api/host', 'POST', jar(), { key: KEY }))).status).toBe(200);
});

test('the hook refuses another site and a non-JSON body', async () => {
	installApp();
	const resolve = async () => new Response('route ran');
	const run = (e: never) => handle({ event: e, resolve } as never);
	const host = await unlock();

	const csrf = await run(event('/api/settings', 'PUT', host, {}, { origin: 'http://192.168.1.99' }));
	expect(csrf.status).toBe(403);
	const form = await run(
		event('/api/settings', 'PUT', host, undefined, {
			origin: ORIGIN,
			'content-type': 'text/plain',
			'content-length': '2'
		})
	);
	expect(form.status).toBe(415);
	expect(await (await run(event('/api/settings', 'PUT', host, {}, { origin: ORIGIN }))).text()).toBe('route ran');
	// Reads stay open: the phones render the settings they cannot change.
	expect(await (await run(event('/api/settings', 'GET', jar()))).text()).toBe('route ran');
});
