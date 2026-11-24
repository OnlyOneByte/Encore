// #1144, DNS rebinding: a page on an attacker's name, rebound to this box, sends that name as Host. core answers only
// to IP addresses, the loopback names, the declared join address and ENCORE_ALLOWED_HOSTS, on /api, pages and /ws.
// Raw node:http, because the subject is the Host header, which fetch and a browser will not let a test choose.
import { test, expect } from '../../world/fixtures';
import { TEST_HOST_KEY } from '../../world/core';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';

test.use({ coreEnv: { ENCORE_ALLOWED_HOSTS: 'karaoke.lan' } });

type Answer = { status: number; text: string; setCookie: string };

/** One request to the test core with a chosen Host. An upgrade answers 101 or the refusal's status. */
function send(baseURL: string, method: string, path: string, headers: Record<string, string>, body?: string) {
	const { hostname, port } = new URL(baseURL);
	return new Promise<Answer>((resolve, reject) => {
		const req = httpRequest({ hostname, port, method, path, headers }, (res) => {
			let text = '';
			res.on('data', (d: Buffer) => (text += d.toString()));
			res.on('end', () =>
				resolve({ status: res.statusCode ?? 0, text, setCookie: String(res.headers['set-cookie'] ?? '') })
			);
		});
		req.on('upgrade', (res, socket) => {
			socket.destroy();
			resolve({ status: res.statusCode ?? 0, text: '', setCookie: '' });
		});
		req.on('error', reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

const upgrade = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13' };
const wsHeaders = (host: string, origin?: string) => ({
	...upgrade,
	'sec-websocket-key': randomBytes(16).toString('base64'),
	host,
	...(origin ? { origin } : {})
});

test('a foreign Host reaches nothing; every name a real setup uses still works', async ({ world }) => {
	const port = new URL(world.baseURL).port;
	const join = (host: string, name: string) =>
		send(
			world.baseURL,
			'POST',
			'/api/join',
			{ host, origin: `http://${host}`, 'content-type': 'application/json' },
			JSON.stringify({ displayName: name, color: '#7c5cff' })
		);

	// The rebinding page: its own name as Host and Origin, which the Origin check alone let through.
	for (const evil of [`evil.example:${port}`, `192.168.1.20.nip.io:${port}`, `localhost.evil.example:${port}`]) {
		const joined = await join(evil, 'Rebound');
		expect(joined.status, `POST /api/join as ${evil}: ${joined.text}`).toBe(421);
		expect(joined.text).toContain('ENCORE_ALLOWED_HOSTS');
		expect((await send(world.baseURL, 'GET', '/api/settings', { host: evil })).status, `GET /api as ${evil}`).toBe(421);
		expect((await send(world.baseURL, 'GET', '/tv', { host: evil })).status, `GET /tv as ${evil}`).toBe(421);
		const ws = await send(world.baseURL, 'GET', '/ws?role=phone', wsHeaders(evil, `http://${evil}`));
		expect(ws.status, `/ws as ${evil}`).toBe(421);
	}
	// A forged X-Forwarded-Host does not move the check while no trusted proxy is declared.
	const forged = { host: `evil.example:${port}`, 'x-forwarded-host': `127.0.0.1:${port}` };
	expect((await send(world.baseURL, 'GET', '/api/settings', forged)).status).toBe(421);

	// The TV at localhost (#1054), a phone from the QR's LAN address, a Docker port mapping and ENCORE_ALLOWED_HOSTS.
	const names = [
		`localhost:${port}`,
		`127.0.0.1:${port}`,
		`192.168.1.20:${port}`,
		`172.17.0.2:3000`,
		`karaoke.lan:${port}`
	];
	for (const [i, host] of names.entries()) {
		const joined = await join(host, `Allowed${i}`);
		expect(joined.status, `POST /api/join as ${host}: ${joined.text}`).toBe(200);
		expect((await send(world.baseURL, 'GET', '/tv', { host })).status, `GET /tv as ${host}`).toBe(200);
		const cookie = joined.setCookie.split(';')[0]!;
		const ws = await send(world.baseURL, 'GET', '/ws?role=phone', { ...wsHeaders(host, `http://${host}`), cookie });
		expect(ws.status, `/ws as ${host}`).toBe(101);
	}

	// The worker dials `ws://core:3000` in compose and sends no Origin, so it is no browser and passes.
	expect((await send(world.baseURL, 'GET', '/ws?role=worker', wsHeaders('core:3000'))).status).toBe(101);
	expect((await send(world.baseURL, 'GET', '/api/settings', { host: 'core:3000' })).status).toBe(421);

	// A join address the host saves is answered at once, with no restart.
	const unlock = await send(
		world.baseURL,
		'POST',
		'/api/host',
		{ host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
		JSON.stringify({ key: TEST_HOST_KEY })
	);
	expect(unlock.status, unlock.text).toBe(200);
	const declared = `encore.home:${port}`;
	expect((await send(world.baseURL, 'GET', '/tv', { host: declared })).status).toBe(421);
	const saved = await send(
		world.baseURL,
		'PUT',
		'/api/settings',
		{ host: `127.0.0.1:${port}`, cookie: unlock.setCookie.split(';')[0]!, 'content-type': 'application/json' },
		JSON.stringify({ joinOrigin: `http://${declared}` })
	);
	expect(saved.status, saved.text).toBe(200);
	expect((await send(world.baseURL, 'GET', '/tv', { host: declared })).status).toBe(200);
	expect((await join(declared, 'Declared')).status).toBe(200);
});
