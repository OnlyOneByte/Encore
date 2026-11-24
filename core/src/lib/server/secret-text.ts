// How core reads a token from the environment. The worker's config.py `clean_token` must stay identical.

/** Drops control and invisible format characters (U+200B, a BOM), then trims; once those are gone, JS `trim()`
 *  and Python `strip()` agree, so core and the worker read one pasted token the same way. */
export function cleanToken(raw: string | null | undefined): string {
	return (raw ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
}

/** Real characters, not UTF-16 units: an emoji is one. */
export const codePoints = (s: string): number => [...s].length;
