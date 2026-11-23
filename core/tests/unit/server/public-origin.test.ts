// The scheme in the TV's join QR. adapter-node computes the protocol as `PROTOCOL_HEADER && header || "https"`, so with
// no proxy header configured it reports **https** for a plain HTTP request: `url.origin` became
// `https://192.168.1.20:3000` on the deployment the README documents, and the QR encoded a URL no phone on the LAN could
// open. Invisible in normal testing, because the usual path is an https tunnel.
import { test, expect, spyOn } from 'bun:test';
import {
	publicOrigin,
	publicOriginIsHttps,
	joinOrigin,
	fallbackJoinOrigin,
	resolveOrigin,
	lanAddresses,
	joinCandidates,
	startupAddress,
	parseLinuxRoute,
	parseMacRoute,
	parseWindowsRoute,
	type DefaultRoute
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
// address: the default route's interface first, then 192.168/16, then 10/8; never 172.16/12 (Docker's and WSL2's NAT),
// never a known virtual interface, never public. Always on this server's own plain-http port.

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
type Ifaces = Record<string, NetworkInterfaceInfo[]>;
const net = (interfaces: Ifaces, route: DefaultRoute | null = null) => ({ interfaces, route });
const LO = { lo: [nic('127.0.0.1', { internal: true })] };
const HOME = net({ ...LO, eth0: [nic('192.168.1.20')] });
const local = (host = 'localhost:3000') => req({ host });
const ips = (interfaces: Ifaces, route: DefaultRoute | null = null) => lanAddresses(net(interfaces, route));

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
/** No declared origin, and this server on PORT (3000 unless given), so a result never depends on the runner's env. */
const bare = <T>(fn: () => T, port = '3000'): T => withEnv('PORT', port, () => withOrigin(undefined, fn));

test("a TV at any loopback spelling advertises the home-network address on the server's own port", () => {
	for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', '0.0.0.0:3000', '[::ffff:127.0.0.1]:3000']) {
		expect(bare(() => fallbackJoinOrigin(local(host), url, HOME))).toBe('http://192.168.1.20:3000');
	}
	// The port is the one this server listens on, whatever port the TV's request came in on.
	expect(bare(() => fallbackJoinOrigin(local('localhost'), url, HOME))).toBe('http://192.168.1.20:3000');
	expect(bare(() => fallbackJoinOrigin(local('localhost:5173'), url, HOME), '4100')).toBe('http://192.168.1.20:4100');
});

test('10.x when there is no 192.168, and 192.168 first whatever the interface order', () => {
	expect(ips({ ...LO, eth0: [nic('10.0.0.7')] })).toEqual(['10.0.0.7']);
	expect(ips({ eth0: [nic('10.0.0.7')], wlan0: [nic('192.168.1.20')] })).toEqual(['192.168.1.20', '10.0.0.7']);
});

test('Docker, WSL2, VM and VPN adapters are never advertised: 172.16/12 or a known virtual name keeps the warning', () => {
	const cases: Ifaces[] = [
		{ ...LO, docker0: [nic('172.17.0.1')] },
		{ ...LO, eth0: [nic('172.28.123.4')] }, // WSL2's NAT
		{ ...LO, eth0: [nic('172.16.0.2')], br: [nic('172.31.255.1')] },
		// A virtual adapter on a home-looking range is still not the phones' network.
		{ docker0: [nic('192.168.99.1')], 'br-1a2b': [nic('10.10.0.1')], veth9: [nic('192.168.5.1')] },
		{ virbr0: [nic('192.168.122.1')], tailscale0: [nic('10.64.0.1')], utun3: [nic('10.8.0.2')] },
		{ 'vEthernet (WSL)': [nic('192.168.240.1')] },
		// The reviewer's list: macOS, VMware, VirtualBox, Parallels, LXC/LXD, VPNs, ZeroTier, Kubernetes.
		{ bridge100: [nic('192.168.64.1')], vmnet8: [nic('192.168.135.1')], vboxnet0: [nic('192.168.56.1')] },
		{ 'VirtualBox Host-Only Network': [nic('192.168.56.1')], 'VMware Network Adapter VMnet8': [nic('192.168.8.1')] },
		{ vnic0: [nic('10.211.55.2')], lxcbr0: [nic('10.0.3.1')], lxdbr0: [nic('10.155.1.1')] },
		{ wg0: [nic('10.8.0.2')], tun0: [nic('10.9.0.2')], tap0: [nic('192.168.7.1')], ztabcdef: [nic('10.147.17.5')] },
		{ 'ZeroTier One [8056c2e21c]': [nic('10.147.17.5')], cni0: [nic('10.42.0.1')], 'flannel.1': [nic('10.42.0.0')] }
	];
	for (const list of cases) {
		expect(ips(list)).toEqual([]);
		expect(bare(() => fallbackJoinOrigin(local(), url, net(list)))).toBe('http://localhost:3000');
	}
});

test('a Docker bridge next to the real NIC: the real NIC is picked', () => {
	const list = { docker0: [nic('192.168.99.1')], eth0: [nic('172.17.0.5')], wlan0: [nic('192.168.1.20')] };
	expect(ips(list)).toEqual(['192.168.1.20']);
});

test("the default route's interface wins over a VM bridge on 192.168, even one with an unknown name", () => {
	// A Mac on a 10.0.0.x router (Xfinity's default) with Apple Virtualization's bridge: must pick 10.0.0.x.
	const mac = { lo0: LO.lo, en0: [nic('10.0.0.23')], bridge100: [nic('192.168.64.1')] };
	expect(ips(mac, { iface: 'en0' })).toEqual(['10.0.0.23']);
	expect(ips(mac)).toEqual(['10.0.0.23']); // route unknown: the denylist is the backstop
	// A bridge no list names: only the route knows. Every other address is still a candidate.
	const odd = { en0: [nic('10.0.0.23')], vmenet7: [nic('192.168.64.1')] };
	expect(ips(odd, { iface: 'en0' })).toEqual(['10.0.0.23', '192.168.64.1']);
	expect(bare(() => fallbackJoinOrigin(local(), url, net(odd, { iface: 'en0' })))).toBe('http://10.0.0.23:3000');
	// Windows names the route by its address. VirtualBox's host-only adapter loses either way.
	const win = { 'Wi-Fi': [nic('10.0.0.5')], 'VirtualBox Host-Only Network': [nic('192.168.56.1')] };
	expect(ips(win, { address: '10.0.0.5' })).toEqual(['10.0.0.5']);
	expect(ips(win)).toEqual(['10.0.0.5']);
	// An adapter no list names (Windows' hotspot bridge): the route's address still puts Wi-Fi first.
	const hotspot = { 'Wi-Fi': [nic('10.0.0.5')], 'Local Area Connection* 10': [nic('192.168.137.1')] };
	expect(ips(hotspot, { address: '10.0.0.5' })).toEqual(['10.0.0.5', '192.168.137.1']);
});

test('a default route the phones cannot use (VPN, WSL2, Docker) falls back to the ranked list', () => {
	expect(ips({ wg0: [nic('10.8.0.2')], wlan0: [nic('192.168.1.20')] }, { iface: 'wg0' })).toEqual(['192.168.1.20']);
	expect(ips({ eth0: [nic('172.28.1.4')] }, { iface: 'eth0' })).toEqual([]);
	expect(ips({ eth0: [nic('10.0.0.7')], wlan0: [nic('192.168.1.20')] }, { iface: 'gone0' })).toEqual([
		'192.168.1.20',
		'10.0.0.7'
	]);
});

test("each OS's default-route output is read for the lowest-metric default", () => {
	const linux = [
		'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
		'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
		'eth0\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0',
		// OpenVPN's def1 half-route 0.0.0.0/1: destination 0 but not a default, whatever its metric.
		'tun0\t00000000\t0100080A\t0003\t0\t0\t0\t00000080\t0\t0\t0',
		'eth0\t0000000A\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0'
	].join('\n');
	expect(parseLinuxRoute(linux)).toEqual({ iface: 'eth0' });
	expect(parseLinuxRoute(linux.split('\n').slice(0, 1).concat(linux.split('\n')[3]!).join('\n'))).toBeNull();
	const mac =
		'   route to: default\ndestination: default\n       mask: default\n    gateway: 10.0.0.1\n  interface: en0\n';
	expect(parseMacRoute(mac)).toEqual({ iface: 'en0' });
	expect(parseMacRoute('route: writing to routing socket: not in table')).toBeNull();
	const win = [
		'IPv4 Route Table',
		'Active Routes:',
		'Network Destination        Netmask          Gateway       Interface  Metric',
		'          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.20     35',
		'          0.0.0.0          0.0.0.0         10.0.0.1        10.0.0.5     25',
		'Persistent Routes:',
		'  Network Address          Netmask  Gateway Address  Metric',
		'          0.0.0.0          0.0.0.0     172.16.0.1       1'
	].join('\r\n');
	expect(parseWindowsRoute(win)).toEqual({ address: '10.0.0.5' });
	expect(parseWindowsRoute('Active Routes:\r\n  None\r\n')).toBeNull();
});

test('a public, reserved, link-local, internal or IPv6 address is never advertised', () => {
	const list = {
		eth0: [nic('203.0.113.5'), nic('240.10.0.3'), nic('169.254.1.1'), nic('11.0.0.1'), nic('192.169.0.1')],
		eth1: [nic('fe80::1', { family: 'IPv6' }), nic('fd00::5', { family: 'IPv6' })],
		lo: [nic('127.0.0.1', { internal: true }), nic('10.0.0.9', { internal: true })]
	};
	expect(ips(list)).toEqual([]);
});

test('several NICs: the first is advertised and every one is a candidate, once each', () => {
	const list = net({
		eth0: [nic('192.168.1.21')],
		wlan0: [nic('192.168.1.20'), nic('192.168.1.21')],
		usb0: [nic('10.0.0.4')]
	});
	expect(bare(() => fallbackJoinOrigin(local(), url, list))).toBe('http://192.168.1.21:3000');
	expect(bare(() => joinCandidates(list))).toEqual([
		'http://192.168.1.21:3000',
		'http://192.168.1.20:3000',
		'http://10.0.0.4:3000'
	]);
	expect(bare(() => joinCandidates(net(LO)))).toEqual([]);
});

test("over a tunnel, the pick and the candidates are still this server's plain http and own port", () => {
	// A tunnel that rewrites Host to localhost, over https: never `https://192.168.1.20` with no port.
	const tunnel = req({ host: 'localhost', 'x-forwarded-proto': 'https' });
	expect(bare(() => fallbackJoinOrigin(tunnel, url, HOME))).toBe('http://192.168.1.20:3000');
	expect(bare(() => joinCandidates(HOME))).toEqual(['http://192.168.1.20:3000']);
	expect(bare(() => joinCandidates(HOME), '4100')).toEqual(['http://192.168.1.20:4100']);
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
	const other = net({ eth0: [nic('10.0.0.7')] });
	expect(bare(() => fallbackJoinOrigin(req({ host: '192.168.1.30:3000' }), url, other))).toBe(
		'http://192.168.1.30:3000'
	);
	const tunnel = req({ host: '127.0.0.1:3000', 'x-forwarded-host': 'party.example', 'x-forwarded-proto': 'https' });
	expect(bare(() => fallbackJoinOrigin(tunnel, url, HOME))).toBe('https://party.example');
});

test('the cookie origin never takes the pick: publicOrigin stays the request', () => {
	expect(withEnv('ENCORE_TEST_INTERFACES', JSON.stringify(HOME.interfaces), () => publicOrigin(local(), url))).toBe(
		'http://localhost:3000'
	);
});

test('HOST=127.0.0.1 listens on loopback only, so nothing is advertised', () => {
	withEnv('ENCORE_TEST_INTERFACES', undefined, () =>
		withEnv('HOST', '127.0.0.1', () => {
			expect(bare(() => fallbackJoinOrigin(local(), url))).toBe('http://localhost:3000');
			expect(bare(() => joinCandidates())).toEqual([]);
			expect(bare(() => startupAddress())).toBeNull();
		})
	);
});

test('HOST unset, 0.0.0.0 or :: listens everywhere, so the real interface list is read', () => {
	// Paired with the test above: on a box with a home-network address (most), only HOST tells the two apart. The
	// default route only reorders the list, so whether there is an address does not depend on it.
	const found = lanAddresses({ interfaces: networkInterfaces(), route: null });
	for (const host of [undefined, '0.0.0.0', '::']) {
		withEnv('ENCORE_TEST_INTERFACES', undefined, () =>
			withEnv('HOST', host, () => {
				const line = bare(() => startupAddress());
				expect(line === null).toBe(found.length === 0);
				if (line !== null) expect(found).toContain(new URL(line).hostname);
			})
		);
	}
});

test('the test hook stands in for the interfaces; a malformed one is ignored with a warning, never a crash', () => {
	expect(
		withEnv('ENCORE_TEST_INTERFACES', JSON.stringify(HOME.interfaces), () => bare(() => joinOrigin(local(), url)))
	).toBe('http://192.168.1.20:3000');
	const warn = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		// Bad JSON, and good JSON of the wrong shape (an object where the list belongs). HOST pins the fallthrough.
		for (const bad of ['{nope', '{"eth0":{"address":"192.168.1.20"}}', '[1]', '{"eth0":[null]}']) {
			warn.mockClear();
			const got = withEnv('HOST', '127.0.0.1', () =>
				withEnv('ENCORE_TEST_INTERFACES', bad, () => bare(() => joinOrigin(local(), url)))
			);
			expect(got).toBe('http://localhost:3000');
			expect(warn).toHaveBeenCalledTimes(1);
		}
	} finally {
		warn.mockRestore();
	}
});

test('the startup line names the same address the QR uses, and a declared one first', () => {
	expect(bare(() => startupAddress(HOME))).toBe('http://192.168.1.20:3000');
	expect(bare(() => startupAddress(net({ docker0: [nic('172.17.0.1')] })))).toBeNull();
	expect(withOrigin('https://karaoke.example', () => startupAddress(HOME))).toBe('https://karaoke.example');
});
