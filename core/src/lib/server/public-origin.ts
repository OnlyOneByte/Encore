// Derived from the request, NEVER `url.origin`: adapter-node's protocol defaults to "https" whenever
// PROTOCOL_HEADER is unset, even on a plain LAN request, so a QR built from it opens on no phone. This
// process only ever speaks plain HTTP itself, so believe a forwarding header when present, else say http.

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
	let stored = '';
	try {
		stored = getApp().settings.getGlobal().joinOrigin;
	} catch {
		// The app singleton is absent under unit load and prerender.
	}
	return stored || fallbackJoinOrigin(request, url);
}

/** What an EMPTY setting resolves to: ENCORE_PUBLIC_ORIGIN, else the request, except that a TV opened at loopback
 *  (the README's setup) advertises this box's home-network address instead. The settings UI shows it. */
export function fallbackJoinOrigin(request: Request, url: URL, interfaces = machineInterfaces()): string {
	const configured = configuredOrigin();
	const origin = resolveOrigin(request, url, configured);
	if (configured) return origin;
	const { protocol, hostname, port } = new URL(origin);
	if (!isLoopback(hostname)) return origin;
	const lan = lanAddresses(interfaces)[0];
	return lan ? `${protocol}//${lan}${port ? `:${port}` : ''}` : origin;
}

/** Every home-network address this box could advertise, on the port the request reached, for the settings UI's
 *  one-tap choices. */
export function joinCandidates(request: Request, url: URL, interfaces = machineInterfaces()): string[] {
	const { protocol, port } = new URL(publicOrigin(request, url));
	return lanAddresses(interfaces).map((ip) => `${protocol}//${ip}${port ? `:${port}` : ''}`);
}

/** The startup line's address: the first home-network address, else null when nothing is advertisable. */
export function startupAddress(port: number, interfaces = machineInterfaces()): string | null {
	const lan = lanAddresses(interfaces)[0];
	return lan ? `http://${lan}:${port}` : null;
}

function isLoopback(hostname: string): boolean {
	const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Docker, libvirt, VPN and Hyper-V/WSL adapters: their addresses are on a network the phones are not. */
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|tailscale|utun|vEthernet)/i;

/**
 * Home-network IPv4 addresses phones can open, best first: 192.168.0.0/16, then 10.0.0.0/8, each in interface order.
 * NEVER 172.16.0.0/12 (where Docker's and WSL2's NAT put their addresses, which phones cannot reach), a virtual
 * interface, or any public address: this only ever names an address on the home network.
 */
export function lanAddresses(interfaces: Interfaces | null): string[] {
	const rank = (ip: string) => {
		const [a, b] = ip.split('.').map(Number);
		return a === 192 && b === 168 ? 0 : a === 10 ? 1 : -1;
	};
	const found = Object.entries(interfaces ?? {})
		.filter(([name]) => !VIRTUAL_INTERFACE.test(name))
		.flatMap(([, list]) => (list ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address))
		.filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && rank(ip) >= 0);
	return [...new Set(found)].sort((x, y) => rank(x) - rank(y));
}

/**
 * The interfaces this server answers on, or null when it listens on one address only (`HOST=127.0.0.1`), where no
 * other address reaches it and nothing may be advertised. Read per call, like ENCORE_PUBLIC_ORIGIN.
 * shortcut: ENCORE_TEST_INTERFACES (JSON, `os.networkInterfaces()`'s shape) stands in for a box bound to every
 * interface, because the probes' core binds 127.0.0.1 and has no LAN. It changes only the advertised text, never what
 * is reachable; never set it in a deployment.
 */
function machineInterfaces(): Interfaces | null {
	const fake = process.env.ENCORE_TEST_INTERFACES;
	if (fake) {
		try {
			return JSON.parse(fake) as Interfaces;
		} catch {
			return null;
		}
	}
	const host = process.env.HOST?.trim();
	if (host && host !== '0.0.0.0' && host !== '::') return null;
	return networkInterfaces();
}

/**
 * Decided the same way `publicOrigin` decides the scheme, NEVER via `url.protocol`. This gates the session
 * cookie's `Secure` attribute, and getting it wrong leaves a Set-Cookie header that looks fine and works on
 * the host itself, surfacing only as a phone that joins yet 401s on /api/me holding no cookie.
 */
export function publicOriginIsHttps(request: Request, url: URL): boolean {
	return publicOrigin(request, url).startsWith('https:');
}
