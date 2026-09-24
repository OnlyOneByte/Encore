// F1 — the room cookie is gone, and no production source may claim the room-scoping chain reads one.
//
// `ROOM_COOKIE = 'encore_room'` was written by /api/join on every join and had exactly ZERO readers: every
// `cookies.get(...)` / `readSessionToken(...)` site reads the SESSION cookie. A room is a tenancy boundary, so
// its id must resolve through the singers row rather than arriving as a client claim
// ($lib/server/realtime/room-scope). A pure deletion cannot red a behavioural test, hence two arms:
//
//  1. STRUCTURAL — a comment-stripped scan asserting no production source names the cookie in CODE. Stripping is
//     load-bearing: the corrected prose in `db/schema.ts` and `api/join/+server.ts` deliberately still NAMES the
//     deleted cookie, so an unstripped scan would red on that honest explanation and push the next author into
//     silence.
//  2. PROSE — a windowed ban on re-asserting that anything READS a room cookie, under any constant name, allowed
//     only when the window explicitly denies it. The defect was never the identifier, it was a comment that
//     recommended the wrong mechanism for a security decision. Same shape as the spotify-enforcement prose guard.
//
// The behavioural half lives next to the route it changed (routes/api/join/join-room-identity.test.ts), which pins
// the whole cookie key set to exactly one entry — so re-adding any second cookie on the join path reds there.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';

/** src — the production tree this guard walks, from the shared anchor so a move cannot point it at nothing. */
const SRC = srcDir;

/**
 * Blank out comments while preserving line structure. Deliberately a comment stripper and not a tokenizer: a
 * string literal containing `//` would be over-stripped, which can only ADD a false pass for the negative arm,
 * and the discrimination test below bounds that risk.
 */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every non-test production source under src. */
function productionSources(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			productionSources(p, out);
			continue;
		}
		if (!/\.(ts|svelte)$/.test(e.name)) continue;
		if (/\.(test|spec)\.ts$/.test(e.name)) continue;
		if (/(^|\/)test-db\.ts$/.test(p)) continue;
		out.push(p);
	}
	return out;
}

const FILES = productionSources(SRC);
const rel = (p: string) => p.slice(SRC.length + 1);
const sources = new Map(FILES.map((p) => [p, readFileSync(p, 'utf8')]));

/** The cookie, by constant name or by its literal value. */
const NAMES_THE_COOKIE = /ROOM_COOKIE|['"`]encore_room['"`]/;

test('F1 non-vacuous: the scan really walks src and can see cookie code', () => {
	expect(FILES.length).toBeGreaterThan(100);
	const sessionHits = FILES.filter((p) => /SESSION_COOKIE/.test(stripComments(sources.get(p)!)));
	expect(sessionHits.length).toBeGreaterThan(3);
	expect(sources.get(join(SRC, 'lib', 'server', 'singers', 'repository.ts'))!).toContain(
		"export const SESSION_COOKIE = 'encore_singer'"
	);
});

test('F1 no production source names the room cookie in CODE', () => {
	const hits = FILES.filter((p) => NAMES_THE_COOKIE.test(stripComments(sources.get(p)!))).map(rel);
	expect(hits).toEqual([]);
});

test('F1 the stripper DISCRIMINATES — a comment mention passes, real code does not', () => {
	// The load-bearing control: without it the ban above could be green because the stripper eats everything, and the
	// honest explanatory prose could not be told apart from a re-added cookie.
	const inAComment = "// the room cookie an earlier change set (ROOM_COOKIE = 'encore_room') had no reader";
	const inABlockComment = "/* ROOM_COOKIE = 'encore_room' */\nconst x = 1;";
	const inCode = "export const ROOM_COOKIE = 'encore_room';";
	expect(NAMES_THE_COOKIE.test(inAComment)).toBe(true); // raw: matches
	expect(NAMES_THE_COOKIE.test(stripComments(inAComment))).toBe(false); // stripped: does not
	expect(NAMES_THE_COOKIE.test(stripComments(inABlockComment))).toBe(false);
	expect(NAMES_THE_COOKIE.test(stripComments(inCode))).toBe(true); // and real code still lands
	// A rename does not escape the ban: the literal value is banned as well as the constant.
	expect(NAMES_THE_COOKIE.test(stripComments("const PARTY_COOKIE = 'encore_room';"))).toBe(true);
});

test('F1 the corrective prose is PRESENT where a reader would look', () => {
	// The negative arm alone is satisfied by silence, and silence is what let the room-cookie design outlive the
	// decision that replaced it. Both files that used to write or credit the cookie must now say the room comes from
	// the resolved join.
	const joinRoute = sources.get(join(SRC, 'routes', 'api', 'join', '+server.ts'))!;
	expect(joinRoute).toMatch(/room-scope/);
	expect(joinRoute).toMatch(/no reader/i);
	const schema = sources.get(join(SRC, 'lib', 'server', 'db', 'schema.ts'))!;
	expect(schema).toMatch(/doJoin/);
});

/**
 * Every ±100-character window around a reading verb that also mentions a room cookie. SYMMETRIC, for the reason
 * the spotify-enforcement prose guard documents: the subject of "reads" usually sits before the verb, so a
 * forward-only window cuts off the word that says who reads and misattributes the sentence.
 */
function readingWindows(src: string): string[] {
	const flat = src.replace(/\s+/g, ' ');
	const out: string[] = [];
	for (const m of flat.matchAll(/\bread[a-z]*\b/gi)) {
		const at = m.index;
		const w = flat.slice(Math.max(0, at - 100), Math.min(flat.length, at + m[0].length + 100));
		if (/room[ _-]?cookie|ROOM_COOKIE|encore_room/i.test(w)) out.push(w);
	}
	return out;
}

/** Innocent = the window DENIES that anything reads it, rather than asserting that something does. */
const isDenial = (w: string): boolean =>
	/\b(no|never|not|zero|nothing|does\s+not|doesn.t|had\s+no|without)\b[^.]{0,60}\bread/i.test(w) ||
	/\bread[a-z]*\b[^.]{0,60}\b(no|never|nothing)\b/i.test(w);

test('F1 no production source ASSERTS that anything reads a room cookie', () => {
	// Anchored on the CLAIM, not the identifier, so re-introducing the design under a new constant name is still
	// caught. A denial is allowed on purpose — the corrected comments have to be able to name what they rule out.
	for (const p of FILES) {
		const asserted = readingWindows(sources.get(p)!).filter((w) => !isDenial(w));
		expect({ file: rel(p), asserted }).toEqual({ file: rel(p), asserted: [] });
	}
});

test('F1 the prose ban DISCRIMINATES — it still flags the exact sentences that shipped', () => {
	const shipped = [
		'The room-scoping chain reads it: #655 keyed playback by room, and #656 keys the queue + roster',
		'#654 sets the identity; the chain that scopes queue/playback to a room reads it.'
	];
	for (const s of shipped) {
		const withSubject = `the ROOM_COOKIE. ${s}`;
		expect(readingWindows(withSubject).filter((w) => !isDenial(w))).not.toEqual([]);
	}
	const corrected =
		'#654 also set a second cookie naming the room; an earlier change chose a different mechanism and the room cookie was left with no reader at all.';
	expect(readingWindows(corrected).filter((w) => !isDenial(w))).toEqual([]);
});

test('F1 the mechanism that DID win is still the one the code uses', () => {
	// Pins the replacement rather than only the absence: if a later change starts resolving a room from anything but
	// the session token, this stops being the right guard and should red loudly.
	const roomScope = sources.get(join(SRC, 'lib', 'server', 'realtime', 'room-scope.ts'))!;
	// Both case-insensitive: the claim is the noun phrase, not its capitalisation. The source writes
	// `TENANCY BOUNDARY` in caps for emphasis, which reds a case-sensitive match while saying exactly
	// what the guard wants said.
	expect(roomScope).toMatch(/session token/i);
	expect(roomScope).toMatch(/tenancy boundary/i);
	const repository = sources.get(join(SRC, 'lib', 'server', 'singers', 'repository.ts'))!;
	expect(repository).toContain('export function readSessionToken');
	expect(stripComments(repository).match(/if \(k === (\w+)\)/)?.[1]).toBe('SESSION_COOKIE');
});

// F2 — the prose half. `StoredSinger`'s docstring said the wire type carries no room because "a phone is never
// told its own room id", and `SingerRepository.create`'s said "a phone never needs to be told its own room". That
// parenthetical was the stated justification for `listPublic` stripping `roomId` while three other row-returning
// projections did not — and it was false at three sites: /api/join returns `roomId` explicitly, and both /api/me
// handlers let it ride along (one into a broadcast). The behaviour is fixed and pinned in
// routes/api/me/me-room-strip.test.ts; these two arms pin the PROSE, because a corrected mechanism under a comment
// that still recommends the old reasoning is how the next writer skips the strip again.

/** The `/** … *\/` block immediately preceding a declaration, by source anchor. */
function docBlockBefore(src: string, anchor: string): string {
	const at = src.indexOf(anchor);
	expect(at).toBeGreaterThan(-1); // the anchor must exist, or this arm silently stops guarding
	const before = src.slice(0, at);
	return before.slice(before.lastIndexOf('/**'));
}

/**
 * Every ±120-character window around `never` that talks about telling a phone its room. Anchored on the CLAIM,
 * not on either file's wording, so the same false justification is caught under different phrasing.
 */
function neverToldWindows(src: string): string[] {
	const flat = src.replace(/\s+/g, ' ');
	const out: string[] = [];
	for (const m of flat.matchAll(/\bnever\b/gi)) {
		const at = m.index;
		const w = flat.slice(Math.max(0, at - 120), Math.min(flat.length, at + m[0].length + 120));
		// `its own room` / `room id`, not a bare `room`: "tell the room" is a BROADCAST, a different
		// sentence entirely, and matching it would flag unrelated prose (measured on server/jobs/worker-hub.ts).
		if (/\bown room\b|\broom[ _]?id\b/i.test(w) && /\btold\b|\btell\b|\blearn/i.test(w)) out.push(w);
	}
	return out;
}

/**
 * Innocent = the window explicitly CONTRADICTS the claim rather than making it. A correction has to be able to
 * name the belief it is overturning; a ban that forbade the words outright would push the next author into saying
 * nothing, which is the state that let the false justification survive the room-scope decision.
 */
const contradictsIt = (w: string): boolean => /\bDOES\b|\bdoes\s+learn\b|\bin\s+fact\b|\bis\s+false\b/.test(w);

test('F2 no production source claims a phone is never told its own room', () => {
	for (const p of FILES) {
		const asserted = neverToldWindows(sources.get(p)!).filter((w) => !contradictsIt(w));
		expect({ file: rel(p), asserted }).toEqual({ file: rel(p), asserted: [] });
	}
});

test('F2 the claim ban DISCRIMINATES — it still flags both sentences that shipped', () => {
	const shipped = [
		'The wire type carries no room (a phone is never told its own room id), but the server reads it off the row',
		'the wire contract is unchanged (a phone never needs to be told its own room), so the column is a server-side scoping key'
	];
	for (const s of shipped) {
		expect(neverToldWindows(s).filter((w) => !contradictsIt(w))).not.toEqual([]);
	}
	expect(
		neverToldWindows('A phone DOES learn its own room id — /api/join returns it in the response body.').filter(
			(w) => !contradictsIt(w)
		)
	).toEqual([]);
});

test('F2 both docstrings now say where a phone DOES learn its room', () => {
	// The positive half: deleting the false parenthetical and saying nothing would satisfy the ban above while leaving
	// `listPublic`'s asymmetry unexplained. Each block is asserted separately.
	const repository = sources.get(join(SRC, 'lib', 'server', 'singers', 'repository.ts'))!;

	const storedDoc = docBlockBefore(repository, 'export type StoredSinger');
	expect(storedDoc).toMatch(/\/api\/join/); // where the phone learns it
	expect(storedDoc).toMatch(/roster|listPublic/i); // what actually strips it, and why
	expect(neverToldWindows(storedDoc).filter((w) => !contradictsIt(w))).toEqual([]);

	const createDoc = docBlockBefore(repository, 'create(displayName');
	expect(createDoc).toMatch(/\/api\/join/);
	expect(createDoc).toMatch(/learn|told/i);
	expect(neverToldWindows(createDoc).filter((w) => !contradictsIt(w))).toEqual([]);
});
