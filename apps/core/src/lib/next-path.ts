/**
 * Resolve a caller-supplied `?next=` value to a destination inside this app.
 *
 * Navigation targets that come from the URL must be validated before use. Both `//evil.example` and
 * `https://evil.example` are accepted by `goto()` and both leave the site, which would turn the join
 * screen into an open redirect — a link that wears this server's address but lands the singer on
 * someone else's page. Only a single-slash absolute path is allowed through; anything else falls back
 * to the remote.
 *
 * A backslash is rejected alongside a forward slash because some URL parsers normalize `/\` to `//`,
 * which would otherwise smuggle a protocol-relative target past a forward-slash-only check.
 */
export function safeNextPath(next: string | null | undefined, fallback = '/'): string {
	if (!next) return fallback;
	if (!next.startsWith('/')) return fallback;
	if (next.startsWith('//') || next.startsWith('/\\')) return fallback;
	return next;
}
