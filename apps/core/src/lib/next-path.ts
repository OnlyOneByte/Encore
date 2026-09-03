/**
 * Resolve a caller-supplied `?next=` to a destination inside this app.
 *
 * An open-redirect guard: `goto()` accepts both `//evil.example` and `https://evil.example`, and both
 * leave the site while wearing this server's address. `/\` is rejected too, because some URL parsers
 * normalize it to `//`.
 */
export function safeNextPath(next: string | null | undefined, fallback = '/'): string {
	if (!next) return fallback;
	if (!next.startsWith('/')) return fallback;
	if (next.startsWith('//') || next.startsWith('/\\')) return fallback;
	return next;
}
