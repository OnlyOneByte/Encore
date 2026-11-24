// The DNS-rebinding guard. docs/SERVER.md#the-host-allowlist
import { test, expect, afterEach } from 'bun:test';
import { hostAllowed, refuseForeignHost } from '$lib/server/http/allowed-host';
import { publicOrigin } from '$lib/server/public-origin';

const ENV = ['ENCORE_ALLOWED_HOSTS', 'ENCORE_PUBLIC_ORIGIN', 'ENCORE_TRUST_PROXY'] as const;
afterEach(() => {
	for (const k of ENV) delete process.env[k];
});

function req(path: string, headers: Record<string, string>): [Request, URL] {
	const url = new URL(`http://${headers.host ?? 'x'}${path}`);
	return [new Request(url, { headers }), url];
}

test('every IP address and the loopback names pass, whatever the port', () => {
	for (const h of ['192.168.1.20:3000', '10.0.0.5', '172.17.0.2:3000', '127.0.0.1:3000', '[::1]:3000', '[fe80::1]'])
		expect(hostAllowed(h), h).toBe(true);
	for (const h of ['localhost:3000', 'LOCALHOST', 'tv.localhost:3000']) expect(hostAllowed(h), h).toBe(true);
});

test('any other name is refused, including ones that look like ours', () => {
	for (const h of [
		'evil.example',
		'evil.example:3000',
		'192.168.1.20.nip.io',
		'localhost.evil.example',
		'evillocalhost',
		'core:3000',
		'',
		'a b',
		'evil.example/x',
		'user@127.0.0.1'
	])
		expect(hostAllowed(h), h).toBe(false);
});

test('ENCORE_ALLOWED_HOSTS and ENCORE_PUBLIC_ORIGIN add names, case-insensitively and ignoring ports', () => {
	process.env.ENCORE_ALLOWED_HOSTS = ' Karaoke.Lan , mybox:8080,';
	process.env.ENCORE_PUBLIC_ORIGIN = 'https://party.example';
	for (const h of ['karaoke.lan:3000', 'MYBOX', 'party.example']) expect(hostAllowed(h), h).toBe(true);
	expect(hostAllowed('other.example')).toBe(false);
});

test('a foreign Host is refused with 421 on /api, pages and a browser /ws', () => {
	for (const path of ['/api/join', '/', '/tv', '/health']) {
		expect(refuseForeignHost(...req(path, { host: 'evil.example:3000' }))?.status, path).toBe(421);
	}
	const ws = req('/ws?role=phone', { host: 'evil.example:3000', origin: 'http://evil.example:3000' });
	expect(refuseForeignHost(...ws)?.status).toBe(421);
	expect(refuseForeignHost(...req('/api/join', { host: '192.168.1.20:3000' }))).toBeNull();
});

test('a /ws handshake with no Origin is not a browser, so the worker on `core:3000` passes', () => {
	expect(refuseForeignHost(...req('/ws?role=worker', { host: 'core:3000' }))).toBeNull();
	// The exemption is the socket's alone: an HTTP request without Origin is still checked.
	expect(refuseForeignHost(...req('/api/state', { host: 'core:3000' }))?.status).toBe(421);
});

test('X-Forwarded-Host and -Proto count only behind ENCORE_TRUST_PROXY=1', () => {
	const headers = { host: '127.0.0.1:3000', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' };
	expect(refuseForeignHost(...req('/api/join', headers))).toBeNull();
	expect(publicOrigin(...req('/tv', headers))).toBe('http://127.0.0.1:3000');
	process.env.ENCORE_TRUST_PROXY = '1';
	expect(refuseForeignHost(...req('/api/join', headers))?.status).toBe(421);
	process.env.ENCORE_ALLOWED_HOSTS = 'evil.example';
	expect(refuseForeignHost(...req('/api/join', headers))).toBeNull();
	expect(publicOrigin(...req('/tv', headers))).toBe('https://evil.example');
});
