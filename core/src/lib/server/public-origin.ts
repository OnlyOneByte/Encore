// Derived from the request, NEVER `url.origin`: adapter-node's protocol defaults to "https" whenever
// PROTOCOL_HEADER is unset, even on a plain LAN request, so a QR built from it opens on no phone. This
// process only ever speaks plain HTTP itself, so believe a forwarding header when present, else say http.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { getApp } from './app';
import { normalizeJoinOrigin } from '../contract';

type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;

/** Comma-separated when proxies chain. */
const PROTO_HEADERS = ['x-forwarded-proto', 'x-forwarded-protocol'] as const;

/**
 * The operator override, outranked for the join QR by the `joinOrigin` setting. Needed because
 * request-derivation is wrong for the TV: on WSL2 the server cannot reach its own LAN address, and a proxy
 * that drops X-Forwarded-Host has the same effect — so a deployment must be able to DECLARE its address.
 * Read per call, not cached, so a restart picks up a changed env var.
 */
function configuredOrigin(): string | null {
	const raw = (typeof process !== 'undefined' ? process.env?.ENCORE_PUBLIC_ORIGIN : undefined)?.trim();
	if (!raw) return null;
	// The same coercion the stored setting goes through, so the two cannot accept different spellings.
	const normalized = normalizeJoinOrigin(raw);
	if (!normalized) {
		// Ignored rather than thrown: a typo here must not take the TV screen down.
		console.warn(`[encore] ENCORE_PUBLIC_ORIGIN is not a usable http(s) origin, ignoring: ${raw}`);
		return null;
	}
	return normalized;
}

/** A non-empty `configured` wins outright; otherwise `host` comes from Host/X-Forwarded-Host rather than
 *  `url`, so a LAN IP, a tunnel hostname and localhost each resolve from where the request came from. */
export function resolveOrigin(request: Request, url: URL, configured: string | null | undefined): string {
	if (configured) return configured;
	const headers = request.headers;
	let proto = '';
	for (const h of PROTO_HEADERS) {
		const raw = headers.get(h);
		if (raw) {
			// A chain of proxies APPENDS, so the FIRST entry is the client-facing scheme.
			proto = raw.split(',')[0]!.trim().toLowerCase();
			break;
		}
	}
	if (proto !== 'http' && proto !== 'https') proto = 'http';
	const host = (headers.get('x-forwarded-host') ?? headers.get('host') ?? url.host).split(',')[0]!.trim();
	return `${proto}://${host}`;
}

/** The scheme the cookie must agree with. Deliberately does NOT consult `joinOrigin`; see below. */
export function publicOrigin(request: Request, url: URL): string {
	return resolveOrigin(request, url, configuredOrigin());
}

/**
 * What the QR encodes: the `joinOrigin` setting, then ENCORE_PUBLIC_ORIGIN, then the request. Deliberately
 * SEPARATE from `publicOrigin`, because the ADVERTISED address and a phone's actual route can differ — a
 * Secure flag decided from the advertised origin marks a plain-http phone's cookie Secure, the browser
 * drops it silently, and /join appears to succeed while /api/me 401s.
 */
export function joinOrigin(request: Request, url: URL): string {
	return storedJoinOrigin() || fallbackJoinOrigin(request, url);
}

function storedJoinOrigin(): string {
	try {
		return getApp().settings.getGlobal().joinOrigin;
	} catch {
		// The app singleton is absent under unit load and prerender.
		return '';
	}
}

/** What an EMPTY setting resolves to: ENCORE_PUBLIC_ORIGIN, else the request, except that a TV opened at loopback
 *  (the README's setup) advertises this box's home-network address instead. The settings UI shows it.
 *  A tunnel that rewrites Host to localhost (`ngrok --host-header=rewrite`) lands here too, so its remote visitors
 *  see the private LAN address: low-sensitivity, and the same address any phone on the LAN already sees. */
export function fallbackJoinOrigin(request: Request, url: URL, net = machineNetwork()): string {
	const configured = configuredOrigin();
	const origin = resolveOrigin(request, url, configured);
	if (configured || !isLoopback(new URL(origin).hostname)) return origin;
	return joinCandidates(net)[0] ?? origin;
}

/** Every home-network address this box could advertise, best first, for the settings UI's one-tap choices. Always
 *  this server's own plain-http port, never the request's: over a tunnel that would be https and the tunnel's port. */
export function joinCandidates(net = machineNetwork()): string[] {
	return lanAddresses(net).map((ip) => `http://${ip}:${serverPort()}`);
}

/** The startup line's address, from the same rule as the QR: the saved address, then ENCORE_PUBLIC_ORIGIN, then the
 *  first home-network address; null when nothing is advertisable. */
export function startupAddress(net = machineNetwork()): string | null {
	return storedJoinOrigin() || configuredOrigin() || joinCandidates(net)[0] || null;
}

/** server.ts's own default, so an address built here names the port it listens on. */
const serverPort = () => Number(process.env.PORT ?? 3000);

function isLoopback(hostname: string): boolean {
	const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	// `0.0.0.0` reaches loopback on Linux and macOS; `::ffff:7f..` is 127/8 in IPv6 form, as URL spells it.
	return (
		h === 'localhost' ||
		h === '::1' ||
		h === '0.0.0.0' ||
		/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ||
		/^::ffff:7f[0-9a-f]{2}:/.test(h)
	);
}

/** The interface list and, where the OS says, which interface carries the default route. */
export type Network = { interfaces: Interfaces; route: DefaultRoute | null };
/** Linux and macOS name the interface; Windows' `route print` gives its address. */
export type DefaultRoute = { iface?: string; address?: string };

/** A backstop for when the default route is unknown: Docker, libvirt, LXC, VM host-only and bridge, VPN and
 *  Hyper-V/WSL adapters. Their addresses are on a network the phones are not. Never complete, so it is not the rule. */
const VIRTUAL_INTERFACE =
	/^(docker|br-|veth|virbr|lxcbr|lxdbr|cni|flannel|bridge|vmnet|vboxnet|vnic|tailscale|utun|wg|tun|tap|zt|vEthernet|VirtualBox|VMware|ZeroTier)/i;

/**
 * Home-network IPv4 addresses phones can open, best first. The interface carrying the default route comes first:
 * that is the network the box (and so the phones) are on, whatever a VM bridge beside it is called. Then, by range:
 * 192.168.0.0/16, then 10.0.0.0/8, each in interface order. NEVER 172.16.0.0/12 (where Docker's and WSL2's NAT put
 * their addresses, which phones cannot reach), a known virtual interface, or any public address: this only ever
 * names an address on the home network.
 */
export function lanAddresses(net: Network | null): string[] {
	const rank = (ip: string) => {
		const [a, b] = ip.split('.').map(Number);
		return a === 192 && b === 168 ? 0 : a === 10 ? 1 : -1;
	};
	const route = net?.route;
	const onRoute = (name: string, ip: string) => (route?.iface === name || route?.address === ip ? 0 : 1);
	const found = Object.entries(net?.interfaces ?? {})
		.filter(([name]) => !VIRTUAL_INTERFACE.test(name))
		.flatMap(([name, list]) =>
			(list ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, ip: a.address }))
		)
		.filter(({ ip }) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && rank(ip) >= 0)
		.sort((x, y) => onRoute(x.name, x.ip) - onRoute(y.name, y.ip) || rank(x.ip) - rank(y.ip));
	return [...new Set(found.map((a) => a.ip))];
}

/** `/proc/net/route`: the default route (destination and mask 0) with the lowest metric. */
export function parseLinuxRoute(text: string): DefaultRoute | null {
	let best: { iface: string; metric: number } | null = null;
	for (const line of text.trim().split('\n').slice(1)) {
		const [iface, dest, , , , , metric, mask] = line.trim().split(/\s+/);
		if (!iface || dest !== '00000000' || mask !== '00000000') continue;
		if (!best || Number(metric) < best.metric) best = { iface, metric: Number(metric) };
	}
	return best && { iface: best.iface };
}

/** `route -n get default` on macOS: its `interface:` line. */
export function parseMacRoute(text: string): DefaultRoute | null {
	const iface = /^\s*interface:\s*(\S+)/m.exec(text)?.[1];
	return iface ? { iface } : null;
}

/** `route print -4 0.0.0.0` on Windows: the default with the lowest metric, as its interface address. The
 *  Persistent Routes section has no interface column, so it never matches. */
export function parseWindowsRoute(text: string): DefaultRoute | null {
	let best: { address: string; metric: number } | null = null;
	for (const m of text.matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+\S+\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s*$/gm)) {
		if (!best || Number(m[2]) < best.metric) best = { address: m[1]!, metric: Number(m[2]) };
	}
	return best && { address: best.address };
}

const ROUTE_TTL_MS = 30_000;
let routeCache: { at: number; route: DefaultRoute | null } | null = null;

/** Fixed argv, no shell, one-second cap; any failure is "unknown", which falls back to the ranked list.
 *  shortcut: cached 30 s, because macOS and Windows spawn a process; a network change shows after that. */
function readDefaultRoute(): DefaultRoute | null {
	if (routeCache && Date.now() - routeCache.at < ROUTE_TTL_MS) return routeCache.route;
	const run = (cmd: string, args: string[]) =>
		execFileSync(cmd, args, { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
	let route: DefaultRoute | null = null;
	try {
		if (process.platform === 'linux') route = parseLinuxRoute(readFileSync('/proc/net/route', 'utf8'));
		else if (process.platform === 'darwin') route = parseMacRoute(run('/sbin/route', ['-n', 'get', 'default']));
		else if (process.platform === 'win32') route = parseWindowsRoute(run('route', ['print', '-4', '0.0.0.0']));
	} catch {
		route = null;
	}
	routeCache = { at: Date.now(), route };
	return route;
}

/**
 * The network this server answers on, or null when it listens on one address only (`HOST=127.0.0.1`), where no
 * other address reaches it and nothing may be advertised. Read per call, like ENCORE_PUBLIC_ORIGIN.
 * shortcut: ENCORE_TEST_INTERFACES (JSON, `os.networkInterfaces()`'s shape) stands in for a box bound to every
 * interface with an unknown default route, because the probes' core binds 127.0.0.1 and has no LAN. It changes only
 * the advertised text, never what is reachable; never set it in a deployment.
 */
function machineNetwork(): Network | null {
	const fake = process.env.ENCORE_TEST_INTERFACES;
	if (fake) {
		const interfaces = parseInterfaces(fake);
		if (interfaces) return { interfaces, route: null };
		// Ignored rather than thrown, like a bad ENCORE_PUBLIC_ORIGIN: a typo must not take the TV down.
		console.warn(`[encore] ENCORE_TEST_INTERFACES is not an interface list, ignoring it`);
	}
	const host = process.env.HOST?.trim();
	if (host && host !== '0.0.0.0' && host !== '::') return null;
	return { interfaces: networkInterfaces(), route: readDefaultRoute() };
}

/** Well-formed JSON of the wrong shape is refused too, so `lanAddresses` never meets a non-array. */
function parseInterfaces(raw: string): Interfaces | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		const ok =
			!!parsed &&
			typeof parsed === 'object' &&
			!Array.isArray(parsed) &&
			Object.values(parsed).every(
				(list) =>
					Array.isArray(list) &&
					list.every((a) => !!a && typeof a === 'object' && typeof (a as { address?: unknown }).address === 'string')
			);
		return ok ? (parsed as Interfaces) : null;
	} catch {
		return null;
	}
}

/**
 * Decided the same way `publicOrigin` decides the scheme, NEVER via `url.protocol`. This gates the session
 * cookie's `Secure` attribute, and getting it wrong leaves a Set-Cookie header that looks fine and works on
 * the host itself, surfacing only as a phone that joins yet 401s on /api/me holding no cookie.
 */
export function publicOriginIsHttps(request: Request, url: URL): boolean {
	return publicOrigin(request, url).startsWith('https:');
}
