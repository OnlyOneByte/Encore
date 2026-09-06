/**
 * Resolve a caller-supplied `?next=` to a destination inside this app.
 *
 * An open-redirect guard: a join link is the one URL handed to strangers at a party, so a `?next=`
 * that can leave the origin would let someone else's page inherit this server's trust. `goto()`
 * accepts `//evil.example` and `https://evil.example`, both of which escape while wearing this
 * server's address; `/\` normalizes to `//` in some parsers; and a percent-encoded tab/LF/CR
 * (`/%09/evil.example`) survives a naive prefix denylist because the WHATWG URL parser strips ASCII
 * tab/LF/CR *before* parsing, turning it back into `//evil.example`.
 *
 * Rather than enumerate every escape, we ALLOWLIST: resolve the target against a synthetic origin and
 * keep it only if it stays on that origin. Anything that reaches out — another scheme, another host,
 * or a control char that lets the parser reach out — collapses to the fallback.
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
