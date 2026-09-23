// HTTP byte-range parsing for the /media route — pure, so it's tested without a server or a file.
//
// WebKit (Safari, every iOS browser) probes a media resource with `Range: bytes=0-1`; a `200` with
// the whole file instead of `206` makes it abandon the resource SILENTLY — no error event, the
// element never reaches `canplaythrough` or fires `timeupdate`. The tell is on the TV (frozen
// lyrics, a song that never ends), not the phone, whose progress bar interpolates from a wall clock
// and keeps climbing regardless. Range support is also what makes seeking possible at all.

/** What to do with a request, once the Range header has been read against the resource's real size. */
export type RangeDecision =
	| { kind: 'full'; size: number }
	/** `start`/`end` are INCLUSIVE byte offsets, as HTTP defines them. */
	| { kind: 'partial'; start: number; end: number; size: number }
	| { kind: 'unsatisfiable'; size: number };

/**
 * Decide how to answer, given the raw `Range` header (or null) and the resource's byte size.
 * Deliberately narrow: only a SINGLE `bytes` range is honoured — multi-range and any other unit
 * fall back to a full `200` (legal; no media element needs more). Both suffix (`bytes=-500`) and
 * open-ended (`bytes=1024-`) forms are supported: media elements use open-ended for probes/seeks,
 * WebKit uses the two-byte `bytes=0-1` form to test whether ranges work at all.
 */
export function parseRangeHeader(header: string | null, size: number): RangeDecision {
	if (!header || !Number.isFinite(size) || size < 0) return { kind: 'full', size };

	const match = /^bytes=(.*)$/i.exec(header.trim());
	if (!match) return { kind: 'full', size }; // an unknown unit is not an error; serve the whole thing

	const spec = match[1].trim();
	if (spec.includes(',')) return { kind: 'full', size }; // multi-range: not worth a multipart body

	const dash = spec.indexOf('-');
	if (dash < 0) return { kind: 'full', size }; // malformed: no dash at all

	const rawStart = spec.slice(0, dash).trim();
	const rawEnd = spec.slice(dash + 1).trim();

	// A zero-byte file can satisfy no range at all — `bytes */0` is the only honest answer.
	if (size === 0) return { kind: 'unsatisfiable', size };

	let start: number;
	let end: number;

	if (rawStart === '') {
		// Suffix `bytes=-N`: the LAST n bytes. Malformed digits are IGNORED (RFC 9110: ignore an
		// invalid Range), but a well-formed `bytes=-0` genuinely cannot be satisfied.
		const n = toInt(rawEnd);
		if (n === null) return { kind: 'full', size };
		if (n <= 0) return { kind: 'unsatisfiable', size };
		start = Math.max(0, size - n);
		end = size - 1;
	} else {
		const s = toInt(rawStart);
		if (s === null) return { kind: 'full', size }; // malformed digits — not a range we understand
		// A start at or past EOF is genuinely unsatisfiable and MUST be a 416, not a truncated 206:
		// answering 206 with no bytes is what makes a player retry forever.
		if (s >= size) return { kind: 'unsatisfiable', size };
		start = s;
		if (rawEnd === '') {
			end = size - 1; // open-ended: to EOF
		} else {
			const e = toInt(rawEnd);
			if (e === null) return { kind: 'full', size };
			if (e < s) return { kind: 'unsatisfiable', size };
			// Clamp past-EOF ends rather than rejecting: a client asking for more than exists is asking
			// for "the rest", and every media element does this on the last chunk of a file.
			end = Math.min(e, size - 1);
		}
	}

	return { kind: 'partial', start, end, size };
}

/** Digits only — no signs, no whitespace, no exponents. Returns null for anything else. */
function toInt(s: string): number | null {
	if (!/^\d+$/.test(s)) return null;
	const n = Number(s);
	return Number.isSafeInteger(n) ? n : null;
}

/** `Content-Range` for a satisfied partial response. */
export function contentRange(start: number, end: number, size: number): string {
	return `bytes ${start}-${end}/${size}`;
}

/** `Content-Range` for a 416 — the only form allowed there, and what tells the client the real size. */
export function unsatisfiedContentRange(size: number): string {
	return `bytes */${size}`;
}
