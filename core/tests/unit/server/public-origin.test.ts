// The scheme in the TV's join QR. adapter-node computes the protocol as `PROTOCOL_HEADER && header || "https"`, so with
// no proxy header configured it reports **https** for a plain HTTP request: `url.origin` became
// `https://192.168.1.20:3000` on the deployment the README documents, and the QR encoded a URL no phone on the LAN could
// open. Invisible in normal testing, because the usual path is an https tunnel.
import { test, expect } from 'bun:test';
import {
	publicOrigin,
	publicOriginIsHttps,
	joinOrigin,
	fallbackJoinOrigin,
	resolveOrigin,
	lanAddresses,
	joinCandidates,
	startupAddress
} from '$lib/server/public-origin';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

const req = (headers: Record<string, string> = {}) => new Request('https://ignored.example/tv', { headers });
const url = new URL('https://ignored.example/tv');

test('a bare LAN request is http, whatever the adapter claims', () => {
	expect(publicOrigin(req({ host: '192.168.1.20:3000' }), url)).toBe('http://192.168.1.20:3000');
});

test('a proxy that reports https is believed — the tunnel case', () => {
	const o = publicOrigin(req({ host: 'encore.example.test', 'x-forwarded-proto': 'https' }), url);
	expect(o).toBe('https://encore.example.test');
});

test('a chain of proxies uses the CLIENT-facing scheme, which is the first entry', () => {
	expect(publicOrigin(req({ host: 'h', 'x-forwarded-proto': 'https, http' }), url)).toBe('https://h');
});

test('x-forwarded-host wins over host, so a tunnel hostname survives the hop', () => {
	const o = publicOrigin(
		req({ host: '127.0.0.1:5180', 'x-forwarded-host': 'party.example', 'x-forwarded-proto': 'https' }),
		url
	);
	expect(o).toBe('https://party.example');
});

test('a junk scheme falls back to http rather than being echoed into the QR', () => {
	expect(publicOrigin(req({ host: 'h', 'x-forwarded-proto': 'javascript' }), url)).toBe('http://h');
	expect(publicOrigin(req({ host: 'h', 'x-forwarded-proto': '' }), url)).toBe('http://h');
});

test('with no Host header at all it falls back to the request URL host', () => {
	expect(publicOrigin(new Request('http://fallback.example:9/tv'), new URL('http://fallback.example:9/tv'))).toBe(
		'http://fallback.example:9'
	);
});

// ENCORE_PUBLIC_ORIGIN. The request is the right source for a PHONE (it reached us, so its route works) and the wrong
// one for the TV: on a Windows/WSL2 box the server often cannot reach its own LAN address, so the only URL that opens
// /tv is localhost — which puts `localhost` in the QR and points every phone at itself.

const withOrigin = <T>(value: string | undefined, fn: () => T): T => {
	const prior = process.env.ENCORE_PUBLIC_ORIGIN;
	if (value === undefined) delete process.env.ENCORE_PUBLIC_ORIGIN;
	else process.env.ENCORE_PUBLIC_ORIGIN = value;
	try {
		return fn();
	} finally {
		if (prior === undefined) delete process.env.ENCORE_PUBLIC_ORIGIN;
		else process.env.ENCORE_PUBLIC_ORIGIN = prior;
	}
};

test('an explicit origin wins over the request — the localhost-TV case', () => {
	// This is the whole point: the TV is loaded on localhost, and the QR must still say the LAN IP.
	const o = withOrigin('http://192.168.1.20:3000', () =>
		publicOrigin(req({ host: 'localhost:3000' }), new URL('http://localhost:3000/tv'))
	);
	expect(o).toBe('http://192.168.1.20:3000');
});

test('an explicit origin also overrides forwarding headers, so one setting is authoritative', () => {
	const o = withOrigin('https://party.example', () =>
		publicOrigin(req({ host: 'h', 'x-forwarded-host': 'proxy.example', 'x-forwarded-proto': 'http' }), url)
	);
	expect(o).toBe('https://party.example');
});

test('a path, query or trailing slash is normalised away — a pasted address bar value works', () => {
	expect(withOrigin('http://10.0.0.5:3000/tv?x=1', () => publicOrigin(req({ host: 'h' }), url))).toBe(
		'http://10.0.0.5:3000'
	);
	expect(withOrigin('http://10.0.0.5:3000/', () => publicOrigin(req({ host: 'h' }), url))).toBe('http://10.0.0.5:3000');
});

test('a malformed or non-http override is IGNORED, not fatal — the TV must still render', () => {
	// A typo here would otherwise take the whole TV screen down; the request-derived value still works
	// for phones, which is the majority case.
	for (const bad of ['not a url', 'ftp://10.0.0.5', 'javascript:alert(1)', '   ']) {
		expect(withOrigin(bad, () => publicOrigin(req({ host: '192.168.1.20:3000' }), url))).toBe(
			'http://192.168.1.20:3000'
		);
	}
});

test('unset falls back to the request, so existing deployments are unchanged', () => {
	expect(withOrigin(undefined, () => publicOrigin(req({ host: '192.168.1.20:3000' }), url))).toBe(
		'http://192.168.1.20:3000'
	);
});

// publicOriginIsHttps: the session cookie's Secure attribute. /api/join used `url.protocol === 'https:'`, and
// adapter-node reports https for every request unless PROTOCOL_HEADER is set, so the session cookie was marked Secure on
// a plain-HTTP LAN party and the phone's browser discarded it: /join returned 200, /api/me then 401 with no cookie.
// Invisible on the host box, because browsers accept Secure over http://localhost, so it only broke actual phones.

test('a plain-HTTP LAN request is NOT https, so the cookie is not marked Secure', () => {
	expect(publicOriginIsHttps(req({ host: '192.168.1.20:3000' }), url)).toBe(false);
});

test('a request through an https proxy IS https, so the cookie stays Secure on a tunnel', () => {
	expect(publicOriginIsHttps(req({ host: 'party.example', 'x-forwarded-proto': 'https' }), url)).toBe(true);
});

test('an explicit https origin marks the cookie Secure', () => {
	expect(withOrigin('https://party.example', () => publicOriginIsHttps(req({ host: 'h' }), url))).toBe(true);
});

test('an explicit http origin does NOT, even when a proxy claims https', () => {
	// The override is authoritative for the QR, so it must be authoritative for the cookie too —
	// otherwise the two disagree about the scheme and the cookie is dropped.
	const secure = withOrigin('http://192.168.1.20:3000', () =>
		publicOriginIsHttps(req({ host: 'h', 'x-forwarded-proto': 'https' }), url)
	);
	expect(secure).toBe(false);
});

test('the cookie flag and the per-request origin can never disagree about the scheme', () => {
	// One derivation, two callers: assert they agree rather than trusting that they do. NOTE this is the PER-REQUEST
	// origin, not the advertised join address — see the joinOrigin block below for why those two are allowed to differ.
	const cases: Record<string, string>[] = [
		{ host: '192.168.1.20:3000' },
		{ host: 'h', 'x-forwarded-proto': 'https' },
		{ host: 'h', 'x-forwarded-proto': 'http' }
	];
	for (const headers of cases) {
		const r = req(headers);
		expect(publicOriginIsHttps(r, url)).toBe(publicOrigin(r, url).startsWith('https:'));
	}
});

// joinOrigin: the address the TV advertises. Same problem as ENCORE_PUBLIC_ORIGIN one layer up — the person who can fix
// a QR that says `localhost` is standing in the room, not restarting the container — so the address is also a stored
// GLOBAL SETTING, which wins over the env var, which wins over the request. `resolveOrigin` is that rule with the source
// of the declared value factored out, so the precedence is testable without standing up an app singleton.

test('a declared origin wins over every header — the localhost-TV case, from the settings page', () => {
	const o = resolveOrigin(
		req({ host: 'localhost:3000', 'x-forwarded-host': 'proxy.example', 'x-forwarded-proto': 'https' }),
		new URL('http://localhost:3000/tv'),
		'http://192.168.1.20:3000'
	);
	expect(o).toBe('http://192.168.1.20:3000');
});

test('an empty or absent declaration falls through to the request, so clearing the field auto-detects', () => {
	for (const declared of ['', null, undefined]) {
		expect(resolveOrigin(req({ host: '192.168.1.20:3000' }), url, declared)).toBe('http://192.168.1.20:3000');
	}
});

test('with no app singleton the join address is the env var, then the request', () => {
	// The settings repository lives on the app, which is absent under unit load and during prerender.
	// That must degrade to the boot-time declaration rather than throwing and blanking the TV.
	expect(withOrigin('http://192.168.1.20:3000', () => joinOrigin(req({ host: 'localhost:3000' }), url))).toBe(
		'http://192.168.1.20:3000'
	);
	expect(withOrigin(undefined, () => joinOrigin(req({ host: '192.168.1.20:3000' }), url))).toBe(
		'http://192.168.1.20:3000'
	);
});

test('fallbackJoinOrigin is what an empty setting resolves to, so the UI can show it', () => {
	// The settings page prints this as the field's placeholder; if it disagreed with what joinOrigin
	// actually falls back to, the UI would advertise an address the TV does not use.
	const r = req({ host: '192.168.1.20:3000' });
	expect(withOrigin(undefined, () => fallbackJoinOrigin(r, url))).toBe(withOrigin(undefined, () => joinOrigin(r, url)));
	expect(withOrigin('http://10.0.0.5:3000', () => fallbackJoinOrigin(r, url))).toBe('http://10.0.0.5:3000');
});

// THE LOOPBACK TV (proposal 25). The README says to open http://localhost:3000/tv on the machine plugged into the TV,
// and with nothing declared the QR then said `localhost`. A loopback request now advertises this box's home-network
// address: 192.168/16, then 10/8, never 172.16/12 (Docker's and WSL2's NAT), never a virtual interface, never public.

const nic = (address: string, extra: Partial<NetworkInterfaceInfo> = {}) =>
	({
		address,
		family: 'IPv4',
		internal: false,
		netmask: '255.255.255.0',
		mac: '00:00:00:00:00:00',
		cidr: null,
		...extra
	}) as NetworkInterfaceInfo;
const LO = { lo: [nic('127.0.0.1', { internal: true })] };
const HOME = { ...LO, eth0: [nic('192.168.1.20')] };
const local = (host = 'localhost:3000') => req({ host });

const withEnv = <T>(name: string, value: string | undefined, fn: () => T): T => {
	const prior = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		return fn();
	} finally {
		if (prior === undefined) delete process.env[name];
		else process.env[name] = prior;
	}
};

test('a TV at localhost, 127.0.0.1 or ::1 advertises the home-network address on the same port', () => {
	for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000']) {
		expect(withOrigin(undefined, () => fallbackJoinOrigin(local(host), url, HOME))).toBe('http://192.168.1.20:3000');
	}
	expect(withOrigin(undefined, () => fallbackJoinOrigin(local('localhost'), url, HOME))).toBe('http://192.168.1.20');
});

test('10.x when there is no 192.168, and 192.168 first whatever the interface order', () => {
	expect(lanAddresses({ ...LO, eth0: [nic('10.0.0.7')] })).toEqual(['10.0.0.7']);
	expect(lanAddresses({ eth0: [nic('10.0.0.7')], wlan0: [nic('192.168.1.20')] })).toEqual(['192.168.1.20', '10.0.0.7']);
});

test('Docker and WSL2 are never advertised: 172.16/12 or a virtual interface keeps the warning', () => {
	const cases = [
		{ ...LO, docker0: [nic('172.17.0.1')] },
		{ ...LO, eth0: [nic('172.28.123.4')] }, // WSL2's NAT
		{ ...LO, eth0: [nic('172.16.0.2')], br: [nic('172.31.255.1')] },
		// A virtual adapter on a home-looking range is still not the phones' network.
		{ docker0: [nic('192.168.99.1')], 'br-1a2b': [nic('10.10.0.1')], veth9: [nic('192.168.5.1')] },
		{ virbr0: [nic('192.168.122.1')], tailscale0: [nic('10.64.0.1')], utun3: [nic('10.8.0.2')] },
		{ 'vEthernet (WSL)': [nic('192.168.240.1')] }
	];
	for (const list of cases) {
		expect(lanAddresses(list)).toEqual([]);
		expect(withOrigin(undefined, () => fallbackJoinOrigin(local(), url, list))).toBe('http://localhost:3000');
	}
});

test('a Docker bridge next to the real NIC: the real NIC is picked', () => {
	const list = { docker0: [nic('192.168.99.1')], eth0: [nic('172.17.0.5')], wlan0: [nic('192.168.1.20')] };
	expect(lanAddresses(list)).toEqual(['192.168.1.20']);
});

test('a public, reserved, link-local, internal or IPv6 address is never advertised', () => {
	const list = {
		eth0: [nic('203.0.113.5'), nic('240.10.0.3'), nic('169.254.1.1'), nic('11.0.0.1'), nic('192.169.0.1')],
		eth1: [nic('fe80::1', { family: 'IPv6' }), nic('fd00::5', { family: 'IPv6' })],
		lo: [nic('127.0.0.1', { internal: true }), nic('10.0.0.9', { internal: true })]
	};
	expect(lanAddresses(list)).toEqual([]);
});

test('several NICs: the first is advertised and every one is a candidate, once each', () => {
	const list = {
		eth0: [nic('192.168.1.21')],
		wlan0: [nic('192.168.1.20'), nic('192.168.1.21')],
		usb0: [nic('10.0.0.4')]
	};
	expect(withOrigin(undefined, () => fallbackJoinOrigin(local(), url, list))).toBe('http://192.168.1.21:3000');
	expect(joinCandidates(local(), url, list)).toEqual([
		'http://192.168.1.21:3000',
		'http://192.168.1.20:3000',
		'http://10.0.0.4:3000'
	]);
	// From a phone on the LAN too: the candidates are the box's, not the request's.
	expect(joinCandidates(req({ host: '192.168.1.20:3000' }), url, list)).toHaveLength(3);
	expect(joinCandidates(local(), url, LO)).toEqual([]);
});

test('ENCORE_PUBLIC_ORIGIN still wins over the home-network pick', () => {
	expect(withOrigin('https://party.example', () => fallbackJoinOrigin(local(), url, HOME))).toBe(
		'https://party.example'
	);
	// Even a declared loopback address: a declaration is never second-guessed.
	expect(withOrigin('http://localhost:3000', () => fallbackJoinOrigin(local(), url, HOME))).toBe(
		'http://localhost:3000'
	);
});

test('a LAN or tunnel request is unchanged: the Host it arrived on wins, as before', () => {
	const other = { eth0: [nic('10.0.0.7')] };
	expect(withOrigin(undefined, () => fallbackJoinOrigin(req({ host: '192.168.1.30:3000' }), url, other))).toBe(
		'http://192.168.1.30:3000'
	);
	const tunnel = req({ host: '127.0.0.1:3000', 'x-forwarded-host': 'party.example', 'x-forwarded-proto': 'https' });
	expect(withOrigin(undefined, () => fallbackJoinOrigin(tunnel, url, HOME))).toBe('https://party.example');
});

test('the cookie origin never takes the pick: publicOrigin stays the request', () => {
	expect(withEnv('ENCORE_TEST_INTERFACES', JSON.stringify(HOME), () => publicOrigin(local(), url))).toBe(
		'http://localhost:3000'
	);
});

test('HOST=127.0.0.1 listens on loopback only, so nothing is advertised', () => {
	withEnv('ENCORE_TEST_INTERFACES', undefined, () =>
		withEnv('HOST', '127.0.0.1', () => {
			expect(withOrigin(undefined, () => fallbackJoinOrigin(local(), url))).toBe('http://localhost:3000');
			expect(joinCandidates(local(), url)).toEqual([]);
			expect(startupAddress(3000)).toBeNull();
		})
	);
});

test('HOST unset, 0.0.0.0 or :: listens everywhere, so the real interface list is read', () => {
	// Paired with the test above: on a box with a home-network address (most), only HOST tells the two apart.
	const real = lanAddresses(networkInterfaces())[0];
	for (const host of [undefined, '0.0.0.0', '::']) {
		withEnv('ENCORE_TEST_INTERFACES', undefined, () =>
			withEnv('HOST', host, () => {
				expect(startupAddress(3000)).toBe(real ? `http://${real}:3000` : null);
			})
		);
	}
});

test('the test hook stands in for the interfaces, and a malformed one advertises nothing', () => {
	withOrigin(undefined, () => {
		expect(withEnv('ENCORE_TEST_INTERFACES', JSON.stringify(HOME), () => joinOrigin(local(), url))).toBe(
			'http://192.168.1.20:3000'
		);
		expect(withEnv('ENCORE_TEST_INTERFACES', '{nope', () => joinOrigin(local(), url))).toBe('http://localhost:3000');
	});
});

test('the startup line names the same address the QR uses', () => {
	expect(startupAddress(3000, HOME)).toBe('http://192.168.1.20:3000');
	expect(startupAddress(3000, { docker0: [nic('172.17.0.1')] })).toBeNull();
});
