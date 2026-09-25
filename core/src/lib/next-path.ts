/**
 * Resolve a caller-supplied `?next=` to a destination inside this app — an open-redirect guard, because a join link
 * is the one URL handed to strangers at a party. `goto()` accepts `//evil.example` and `https://evil.example`; `/\`
 * normalizes to `//` in some parsers; and a percent-encoded tab/LF/CR survives a naive prefix denylist, because the
 * WHATWG URL parser strips ASCII tab/LF/CR BEFORE parsing. So we ALLOWLIST: resolve the target against a synthetic
 * origin and keep it only if it stays there.
 */
export function safeNextPath(next: string | null | undefined, fallback = '/'): string {
	if (!next) return fallback;
	if (!next.startsWith('/')) return fallback;
	let resolved: URL;
	try {
		resolved = new URL(next, `http://x.invalid`);
	} catch {
		return fallback;
	}
	if (resolved.origin !== `http://x.invalid`) return fallback;
	return resolved.pathname + resolved.search + resolved.hash;
}
