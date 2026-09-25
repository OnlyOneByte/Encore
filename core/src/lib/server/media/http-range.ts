// PURE, so it tests without a server or a file. WebKit probes a media resource with `Range: bytes=0-1`, and
// a `200` with the whole file instead of `206` makes it abandon the resource SILENTLY — no error event, and
// the element never reaches `canplaythrough`. The tell is on the TV, not the phone, whose progress bar
// interpolates from a wall clock and keeps climbing. Range support is also what makes seeking possible.

/** What to do with a request, once the Range header has been read against the resource's real size. */
export type RangeDecision =
	| { kind: 'full'; size: number }
	/** `start`/`end` are INCLUSIVE byte offsets, as HTTP defines them. */
	| { kind: 'partial'; start: number; end: number; size: number }
	| { kind: 'unsatisfiable'; size: number };

/**
 * Deliberately narrow: only a SINGLE `bytes` range is honoured, and multi-range or any other unit falls back
 * to a full `200`, which is legal and enough for every media element. Both suffix and open-ended forms are
 * supported, because elements use open-ended for seeks and WebKit uses `bytes=0-1` to test range support.
 */
export function parseRangeHeader(header: string | null, size: number): RangeDecision {
	if (!header || !Number.isFinite(size) || size < 0) return { kind: 'full', size };

	const match = /^bytes=(.*)$/i.exec(header.trim());
	if (!match) return { kind: 'full', size }; // an unknown unit is not an error; serve the whole thing

	const spec = match[1]!.trim();
	if (spec.includes(',')) return { kind: 'full', size }; // multi-range: not worth a multipart body

	const dash = spec.indexOf('-');
	if (dash < 0) return { kind: 'full', size }; // malformed: no dash at all

	const rawStart = spec.slice(0, dash).trim();
	const rawEnd = spec.slice(dash + 1).trim();

	// A zero-byte file satisfies no range: `bytes */0` is the only honest answer.
	if (size === 0) return { kind: 'unsatisfiable', size };

	let start: number;
	let end: number;

	if (rawStart === '') {
		// The LAST n bytes. Malformed digits are IGNORED per RFC 9110, but a well-formed `bytes=-0` cannot
		// be satisfied.
		const n = toInt(rawEnd);
		if (n === null) return { kind: 'full', size };
		if (n <= 0) return { kind: 'unsatisfiable', size };
		start = Math.max(0, size - n);
		end = size - 1;
	} else {
		const s = toInt(rawStart);
		if (s === null) return { kind: 'full', size }; // malformed digits — not a range we understand
		// At or past EOF MUST be a 416, not a truncated 206: a 206 with no bytes makes a player retry forever.
		if (s >= size) return { kind: 'unsatisfiable', size };
		start = s;
		if (rawEnd === '') {
			end = size - 1; // open-ended: to EOF
		} else {
			const e = toInt(rawEnd);
			if (e === null) return { kind: 'full', size };
			if (e < s) return { kind: 'unsatisfiable', size };
			// CLAMPED rather than rejected: a client asking past EOF is asking for "the rest", which every
			// media element does on the last chunk.
			end = Math.min(e, size - 1);
		}
	}

	return { kind: 'partial', start, end, size };
}

/** Digits only: no signs, whitespace or exponents. */
function toInt(s: string): number | null {
	if (!/^\d+$/.test(s)) return null;
	const n = Number(s);
	return Number.isSafeInteger(n) ? n : null;
}

/** `Content-Range` for a satisfied partial response. */
export function contentRange(start: number, end: number, size: number): string {
	return `bytes ${start}-${end}/${size}`;
}

/** The only form allowed on a 416, and what tells the client the real size. */
export function unsatisfiedContentRange(size: number): string {
	return `bytes */${size}`;
}
