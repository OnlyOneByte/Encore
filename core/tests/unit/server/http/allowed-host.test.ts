// The DNS-rebinding guard. docs/SERVER.md#the-host-allowlist
import { test, expect, afterEach } from 'bun:test';
import { hostAllowed, ownNames, refuseForeignHost, requestUrl, unreadableHost } from '$lib/server/http/allowed-host';
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

test('a missing or malformed Host gets 400, not a 500 or a 421', () => {
	// What Bun hands over for HTTP/1.0 with no Host, or an unbracketed `::1`: a URL that does not parse.
	expect(requestUrl({ url: '/tv' } as Request)).toBeNull();
	expect(requestUrl(new Request('http://127.0.0.1:3000/tv'))?.pathname).toBe('/tv');
	expect(unreadableHost().status).toBe(400);
	const url = new URL('http://x/tv');
	for (const host of ['', 'a b', '127.0.0.1, evil.example', '::1'])
		expect(refuseForeignHost(new Request(url, { headers: { host } }), url)?.status, host).toBe(400);
});

test('one trailing dot is the same name', () => {
	process.env.ENCORE_ALLOWED_HOSTS = 'mybox.local';
	for (const h of ['mybox.local.', 'MYBOX.LOCAL.:3000', 'localhost.']) expect(hostAllowed(h), h).toBe(true);
	for (const h of ['mybox.local..', 'evil.example.', '.']) expect(hostAllowed(h), h).toBe(false);
});

test('`\\`, `%` and `,` are refused, so the name checked is the name sent', () => {
	for (const h of ['127.0.0.1\\evil.example', '%6cocalhost', '%31%32%37.0.0.1', '127.0.0.1,evil.example'])
		expect(hostAllowed(h), h).toBe(false);
});

test('only X-Forwarded-Host is split on commas', () => {
	process.env.ENCORE_TRUST_PROXY = '1';
	const chain = { host: 'core:3000', 'x-forwarded-host': '127.0.0.1:3000, proxy.internal' };
	expect(refuseForeignHost(...req('/tv', chain))).toBeNull();
	delete process.env.ENCORE_TRUST_PROXY;
	expect(refuseForeignHost(...req('/tv', { host: '127.0.0.1,evil.example' }))?.status).toBe(400);
});

test("a native run answers to the box's hostname and its .local; a container adds none", () => {
	expect(ownNames(false, 'MyBox')).toEqual(['mybox', 'mybox.local']);
	expect(ownNames(false, 'MyMac.local')).toEqual(['mymac.local']);
	expect(ownNames(false, 'bad host')).toEqual([]);
	expect(ownNames(true, '3f2a9c1d0b7e')).toEqual([]);
});

test('the 421 echoes the refused name, escaped and capped, and says where the setting goes', async () => {
	const body = await refuseForeignHost(...req('/tv', { host: 'Evil.Example:3000' }))!.text();
	expect(body).toContain('"evil.example"');
	expect(body).toContain('ENCORE_ALLOWED_HOSTS');
	expect(body).toContain('docker/.env');
	expect(body).toContain('restart core');
	const long = await refuseForeignHost(...req('/tv', { host: `${'a'.repeat(60)}.${'b'.repeat(60)}` }))!.text();
	expect(long).toContain(`"${'a'.repeat(60)}.${'b'.repeat(39)}"`);
	const res = refuseForeignHost(...req('/tv', { host: 'xn--80ak6aa92e.com' }))!;
	expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
	expect(res.headers.get('x-content-type-options')).toBe('nosniff');
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
