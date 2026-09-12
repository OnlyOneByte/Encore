// F1 — the room cookie is gone, and no production source may claim the room-scoping chain reads
// one.
//
// `ROOM_COOKIE = 'encore_room'` was written by /api/join on every join, with a 30-day `maxAge`, and had
// exactly ZERO readers: all nine `cookies.get(...)` / `readSessionToken(...)` sites in the app read the
// SESSION cookie, and `readSessionToken` parses only that name. The room-cookie design made the room identity a
// cookie the phone carries; the room-scope decision then chose the session token instead and said why — a room is a
// tenancy boundary, so its id must resolve through the singers row rather than arriving as a client
// claim ($server/realtime/room-scope). All of the room-identity tickets are closed, so no reader was ever coming.
//
// A pure deletion cannot red a behavioural test by construction, which is why this guard exists in two
// arms:
//
//  1. STRUCTURAL — a comment-stripped scan asserting no production source names the cookie in CODE.
//     Stripping is load-bearing rather than decorative: the corrected prose in `db/schema.ts` and
//     `api/join/+server.ts` deliberately still NAMES the deleted cookie, so a reader who wonders where
//     the room identity comes from is told, in the file, that this was tried and rejected. An
//     unstripped scan would red on that honest explanation and push the next author into silence.
//  2. PROSE — a windowed ban on re-asserting that anything READS a room cookie, under any constant
//     name, allowed only when the window explicitly denies it. Same shape as the spotify-enforcement prose guard: the
//     defect was never the identifier, it was a comment that recommended the wrong mechanism for a
//     security decision.
//
// The behavioural half of the deletion lives next to the route it changed
// (routes/api/join/join-room-identity.test.ts), which now pins the whole cookie key set to exactly one
// entry — so re-adding any second cookie on the join path reds there regardless of its name.
//
// BASE-RED on origin/main: the structural arm reports two code hits
// (server/singers/repository.ts, routes/api/join/+server.ts) and the prose arm reports the
// repository.ts and +server.ts sentences that credit the chain with reading it.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appSrc } from '@encore/test-support';

/**
 * apps/core/src — the production tree this guard walks. Was `at('apps/core/src')`, counted
 * out from this guard's old home in apps/core/src/server/singers; it is the shared anchor now, so the
 * scan cannot be pointed at nothing by moving the test.
 */
const SRC = appSrc;

/**
 * Blank out comments while preserving line structure.
 *
 * Deliberately a comment stripper and not a tokenizer: a string literal containing `//` would be
 * over-stripped, which can only ever ADD a false pass for this guard's negative arm, and the
 * discrimination test below plus the code hit on base bound that risk.
 */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every non-test production source under apps/core/src. */
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

test('F1 non-vacuous: the scan really walks apps/core/src and can see cookie code', () => {
	// A scan that found no files, or files it could not read, would pass every ban below on silence.
	expect(FILES.length).toBeGreaterThan(100);
	const sessionHits = FILES.filter((p) => /SESSION_COOKIE/.test(stripComments(sources.get(p)!)));
	expect(sessionHits.length).toBeGreaterThan(3);
	// and the session cookie's own declaration is still where the room cookie's used to be
	expect(sources.get(join(SRC, 'server', 'singers', 'repository.ts'))!).toContain(
		"export const SESSION_COOKIE = 'encore_singer'"
	);
});

test('F1 no production source names the room cookie in CODE', () => {
	const hits = FILES.filter((p) => NAMES_THE_COOKIE.test(stripComments(sources.get(p)!))).map(rel);
	expect(hits).toEqual([]);
});

test('F1 the stripper DISCRIMINATES — a comment mention passes, real code does not', () => {
	// The load-bearing control. Without it the ban above could be green because the stripper eats
	// everything, and the honest explanatory prose could not be told apart from a re-added cookie.
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
	// decision that replaced it. Both files that used to write or credit the cookie must now say the
	// room comes from the resolved join, not from a cookie.
	const joinRoute = sources.get(join(SRC, 'routes', 'api', 'join', '+server.ts'))!;
	expect(joinRoute).toMatch(/room-scope/);
	expect(joinRoute).toMatch(/no reader/i);
	const schema = sources.get(join(SRC, 'server', 'db', 'schema.ts'))!;
	expect(schema).toMatch(/doJoin/);
});

/**
 * Every ±100-character window around a reading verb that also mentions a room cookie.
 *
 * Symmetric, for the reason the spotify-enforcement prose guard documents: the subject of "reads"
 * usually sits before the verb, so a forward-only window cuts off the word that says who reads and
 * misattributes the sentence.
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
	// Anchored on the CLAIM, not the identifier, so re-introducing the room-cookie design under a new constant
	// name is still caught. A denial is allowed on purpose — the corrected comments have to be able to
	// name the mechanism they rule out, and the test above requires them to.
	for (const p of FILES) {
		const asserted = readingWindows(sources.get(p)!).filter((w) => !isDenial(w));
		expect({ file: rel(p), asserted }).toEqual({ file: rel(p), asserted: [] });
	}
});

test('F1 the prose ban DISCRIMINATES — it still flags the exact sentences that shipped', () => {
	// Replay the two comments verbatim from base. If the matcher stopped firing, the rule above would be
	// green on a tree that had re-added them.
	const shipped = [
		'The room-scoping chain reads it: #655 keyed playback by room, and #656 keys the queue + roster',
		'#654 sets the identity; the chain that scopes queue/playback to a room reads it.'
	];
	for (const s of shipped) {
		// each names the mechanism within the window of a reading verb...
		const withSubject = `the ROOM_COOKIE. ${s}`;
		expect(readingWindows(withSubject).filter((w) => !isDenial(w))).not.toEqual([]);
	}
	// ...and the honest correction survives it
	const corrected =
		'#654 also set a second cookie naming the room; an earlier change chose a different mechanism and the room cookie was left with no reader at all.';
	expect(readingWindows(corrected).filter((w) => !isDenial(w))).toEqual([]);
});

test('F1 the mechanism that DID win is still the one the code uses', () => {
	// Pins the replacement rather than only the absence: if a later change starts resolving a room from
	// anything but the session token, this stops being the right guard and should red loudly.
	const roomScope = sources.get(join(SRC, 'server', 'realtime', 'room-scope.ts'))!;
	expect(roomScope).toMatch(/session token/i);
	expect(roomScope).toMatch(/tenancy boundary/);
	const repository = sources.get(join(SRC, 'server', 'singers', 'repository.ts'))!;
	expect(repository).toContain('export function readSessionToken');
	// readSessionToken parses exactly one cookie name, and it is the session one
	expect(stripComments(repository).match(/if \(k === (\w+)\)/)?.[1]).toBe('SESSION_COOKIE');
});

// ── F2 — the prose half ──────────────────────────────────────────────────────
//
// `StoredSinger`'s docstring said the wire type carries no room because "a phone is never told its own
// room id", and `SingerRepository.create`'s said "a phone never needs to be told its own room". That
// parenthetical was the stated justification for `listPublic` stripping `roomId` while three other
// row-returning projections did not — and it was false at three sites: /api/join returns `roomId`
// explicitly, and both /api/me handlers let it ride along (one of them into a broadcast). The behaviour
// is fixed and pinned in routes/api/me/me-room-strip-797.test.ts; these two arms pin the PROSE, because
// a corrected mechanism under a comment that still recommends the old reasoning is how the next writer
// skips the strip again.

/** The `/** … *\/` block immediately preceding a declaration, by source anchor. */
function docBlockBefore(src: string, anchor: string): string {
	const at = src.indexOf(anchor);
	expect(at).toBeGreaterThan(-1); // the anchor must exist, or this arm silently stops guarding
	const before = src.slice(0, at);
	return before.slice(before.lastIndexOf('/**'));
}

/**
 * Every ±120-character window around `never` that talks about telling a phone its room.
 *
 * Anchored on the CLAIM, not on either file's wording, so the same false justification is caught if it
 * reappears in a third docstring or under different phrasing.
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
 * Innocent = the window explicitly CONTRADICTS the claim rather than making it.
 *
 * Needed for the same reason the spotify-enforcement prose guard needs its denial escape: a correction
 * has to be able to name the belief it is overturning, and a ban that forbade the words outright would
 * push the next author into saying nothing — which is the state that let the false justification
 * survive the room-scope decision.
 */
const contradictsIt = (w: string): boolean => /\bDOES\b|\bdoes\s+learn\b|\bin\s+fact\b|\bis\s+false\b/.test(w);

test('F2 no production source claims a phone is never told its own room', () => {
	for (const p of FILES) {
		const asserted = neverToldWindows(sources.get(p)!).filter((w) => !contradictsIt(w));
		expect({ file: rel(p), asserted }).toEqual({ file: rel(p), asserted: [] });
	}
});

test('F2 the claim ban DISCRIMINATES — it still flags both sentences that shipped', () => {
	// Replay them verbatim from base. Without this the rule above could be green because the matcher
	// never fires on the shape it is meant to catch.
	const shipped = [
		'The wire type carries no room (a phone is never told its own room id), but the server reads it off the row',
		'the wire contract is unchanged (a phone never needs to be told its own room), so the column is a server-side scoping key'
	];
	for (const s of shipped) {
		expect(neverToldWindows(s).filter((w) => !contradictsIt(w))).not.toEqual([]);
	}
	// and an honest correction survives the ban
	expect(
		neverToldWindows('A phone DOES learn its own room id — /api/join returns it in the response body.').filter(
			(w) => !contradictsIt(w)
		)
	).toEqual([]);
});

test('F2 both docstrings now say where a phone DOES learn its room', () => {
	// The positive half: deleting the false parenthetical and saying nothing would satisfy the ban above
	// while leaving `listPublic`'s asymmetry unexplained, which is what the finding is about. Each of the
	// two blocks is asserted separately so a correction to one cannot cover for the other.
	const repository = sources.get(join(SRC, 'server', 'singers', 'repository.ts'))!;

	const storedDoc = docBlockBefore(repository, 'export type StoredSinger');
	expect(storedDoc).toMatch(/\/api\/join/); // where the phone learns it
	expect(storedDoc).toMatch(/roster|listPublic/i); // what actually strips it, and why
	expect(neverToldWindows(storedDoc).filter((w) => !contradictsIt(w))).toEqual([]);

	const createDoc = docBlockBefore(repository, 'create(displayName');
	expect(createDoc).toMatch(/\/api\/join/);
	expect(createDoc).toMatch(/learn|told/i);
	expect(neverToldWindows(createDoc).filter((w) => !contradictsIt(w))).toEqual([]);
});
