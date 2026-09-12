// XR-MED-10 (docs/arch/01-media.md) — "A `MediaStore` member with no production caller is not a
// capability." Every method on the `MediaStore` interface has at least one PRODUCTION call site, or it
// is named in the ledger below with the reason it has none.
//
// THE DEFECT THIS PINS. `MediaStore.url()` presigned a 1-hour direct S3 URL and was documented as "how
// the TV resolves a playable source for a Media". It had ZERO production callers: `TvPlayer.svelte` and
// `LyricsOverlay.svelte` string-build `/media/${ref}`, and the route serves every store kind by range.
// Its ONLY callers were in `tests/unit/core/server/media/store.test.ts` — so the method was covered,
// exercised, and green, while being unreachable from the running product. A coverage number cannot tell
// those two states apart, which is exactly why this guard reads CALL SITES instead.
//
// It was DELETED rather than wired up (see the on-record note in src/routes/media/[...path]/+server.ts
// for the three regressions wiring it would have caused). This file pins that outcome from both sides:
//   1. the deleted symbols stay deleted, and
//   2. the general rule that produced the decision is enforced for every OTHER member, driven off the
//      interface declaration — so a member added later is covered automatically rather than needing
//      this file edited to notice it.
//
// WHY A LEDGER RATHER THAN A FLAT ASSERTION. Reading the tree honestly, `url()` was not the only member
// without a consumer: `exists` and `put` have none either. Failing on those would either force an
// out-of-scope deletion or invite the assertion to be watered down. Instead each is listed with its
// reason, and the ledger is checked in BOTH directions — a listed member that gains a caller reds
// (stale entry), and a listed name that is not a member reds (renamed away). `url` may never be added
// to it; that is a separate test with no exemption path.
import { test, expect } from 'bun:test';
import { read, filesUnder, relative, at } from '@encore/test-support';

const STORE = 'src/lib/server/media/store.ts';
const OBJECT_STORE = 'src/lib/server/media/object-store.ts';
const ROUTE = 'src/routes/media/[...path]/+server.ts';

// Repo stripComments convention (icon-centring.test.ts et al.), extended to // line comments. BLANKS
// rather than deletes so any reported offset still lines up. Load-bearing here: the route's on-record
// note NAMES every deleted symbol (`MediaStore.url()`, `mediaProxyUrl`, `presign`, ...) precisely so a
// reader does not re-add them as an oversight. Without blanking, that note would trip the very
// assertions it exists to explain.
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/** The `export interface MediaStore { ... }` body, comments stripped, brace-sliced. */
function mediaStoreInterfaceBody(): string {
	const src = stripComments(read(STORE));
	const start = src.indexOf('export interface MediaStore');
	expect(start).toBeGreaterThan(-1); // non-vacuous: the declaration must exist
	const open = src.indexOf('{', start);
	expect(open).toBeGreaterThan(-1);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) return src.slice(open + 1, i);
		}
	}
	throw new Error('MediaStore interface body is unbalanced — the slice cannot be trusted');
}

/**
 * Method members of the interface: `name(`, `name?(` — the optional marker included on purpose, since
 * `size`/`getRange` are optional-by-design and are the two members that ARE called.
 */
function methodMembers(body: string): string[] {
	return [...body.matchAll(/(?:^|\n)\s*(\w+)\??\s*\(/g)].map((m) => m[1]);
}

/** Non-method members (plain properties), so a future property cannot slip past unexamined. */
function propertyMembers(body: string): string[] {
	return [...body.matchAll(/(?:^|\n)\s*(?:readonly\s+)?(\w+)\??\s*:/g)].map((m) => m[1]);
}

// Production source: the app tree plus the Bun.serve entry, MINUS the two files that declare and
// implement the interface. An implementation calling its own sibling would satisfy nothing — the
// requirement is that a CONSUMER exists.
const PRODUCTION = [...filesUnder('src', ['.ts', '.svelte']), at('server.ts')]
	.map((abs) => relative(abs))
	.filter((rel) => rel !== STORE && rel !== OBJECT_STORE);

/**
 * Names a file binds a `MediaStore` instance to. A bare `.member(` scan would be worthless here —
 * `.get(` alone matches every `Map.get` in the tree — so a call only counts when its RECEIVER is
 * demonstrably a media store: a binding assigned from a `.mediaStore` expression (the route's
 * `const store = getApp().mediaStore`), or the property accessed inline (`app.mediaStore.get(...)`).
 */
function storeBindings(src: string): string[] {
	const names = new Set<string>();
	if (/\.mediaStore\b/.test(src)) names.add('mediaStore');
	for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*[^;\n]*\.mediaStore\b/g)) {
		names.add(m[1]);
	}
	return [...names];
}

/** Repo-relative files where `member` is called on a bound media store. */
function productionCallSites(member: string): string[] {
	const hits: string[] = [];
	for (const rel of PRODUCTION) {
		const src = stripComments(read(rel));
		const bindings = storeBindings(src);
		if (!bindings.length) continue;
		const called = bindings.some((b) => new RegExp(`\\b${b}\\.${member}\\b`).test(src));
		if (called) hits.push(rel);
	}
	return hits;
}

// ── the ledger: members with no consumer, and why each is nonetheless kept ─────────────────────────
// Keep this SHORT and specific. An entry is a statement that the member is deliberately unconsumed
// today, not a parking space for the next unreachable capability.
const NO_CONSUMER_BY_DESIGN: Record<string, string> = {
	exists:
		'The readiness path reads the catalog + sidecar, not the store, so nothing probes existence ' +
		'through this interface today. Kept as the read-side pair of put(): a store that cannot be ' +
		'asked whether a ref landed cannot be reconciled after a worker upload.',
	put:
		'The only writer of stems/lyrics is the Python worker, which talks to the volume or bucket ' +
		'directly using the config it receives in worker:welcome — it does not run this TypeScript. ' +
		'Kept because the interface would otherwise describe a read-only store, which would be a false ' +
		'account of what a MediaStore is for.'
};

// Names that may NEVER be reinstated on this interface, ledger or not. A store answers BYTES; the
// same-origin /media route is the sole URL builder. Re-adding one of these is a product decision about
// cross-origin playback (docs/DECISIONS.md deferred FFT work depends on same-origin), so it must break
// a test and be argued, not land as a plausible-looking convenience method.
const FORBIDDEN_MEMBERS = ['url', 'presignedUrl', 'signedUrl', 'directUrl', 'publicUrl'];

test('every MediaStore METHOD has a production call site, or a ledger entry saying why not', () => {
	const members = methodMembers(mediaStoreInterfaceBody());
	// non-vacuity: a regex that stopped matching would otherwise assert nothing at all
	expect(members).toContain('get');
	expect(members).toContain('size');
	expect(members).toContain('getRange');
	expect(members.length).toBeGreaterThanOrEqual(5);

	const unconsumed: string[] = [];
	for (const member of members) {
		if (productionCallSites(member).length === 0) unconsumed.push(member);
	}
	// The set with no consumer must be EXACTLY the ledger — no more (an unreachable new member) and no
	// fewer (a stale entry). Compared as sorted sets so the failure names the member either way.
	expect(unconsumed.sort()).toEqual(Object.keys(NO_CONSUMER_BY_DESIGN).sort());
});

test('the ledger names only real members, and every entry carries a reason', () => {
	const members = methodMembers(mediaStoreInterfaceBody());
	for (const [name, reason] of Object.entries(NO_CONSUMER_BY_DESIGN)) {
		expect(members).toContain(name); // a renamed-away member must not linger as an exemption
		expect(reason.length).toBeGreaterThan(60); // a reason, not a shrug
	}
});

test('the interface declares no property member other than the `kind` discriminant', () => {
	// The caller rule above covers METHODS. A property cannot be "called", so one added here would sit
	// outside it — fail instead, so the next property is examined rather than silently exempt.
	expect(propertyMembers(mediaStoreInterfaceBody())).toEqual(['kind']);
});

test('no URL-returning member is reinstated on MediaStore, and none is smuggled into the ledger', () => {
	const body = mediaStoreInterfaceBody();
	for (const banned of FORBIDDEN_MEMBERS) {
		expect(body).not.toMatch(new RegExp(`(?:^|\\n)\\s*${banned}\\??\\s*[(:]`));
		expect(Object.keys(NO_CONSUMER_BY_DESIGN)).not.toContain(banned);
	}
});

test('the deleted presign path stays deleted in both store modules', () => {
	const store = stripComments(read(STORE));
	const objectStore = stripComments(read(OBJECT_STORE));
	// `mediaProxyUrl` was reachable only from url() and existed only to build the string the route
	// already builds; `presign` on S3Like existed only to serve url().
	for (const src of [store, objectStore]) {
		expect(src).not.toMatch(/\bmediaProxyUrl\b/);
		expect(src).not.toMatch(/\bpresign\b/);
		expect(src).not.toMatch(/\bpresignExpiresIn\b/);
		expect(src).not.toMatch(/\bproxyUrls\b/);
		expect(src).not.toMatch(/\bObjectMediaStoreOpts\b/);
	}
	// and nothing in production resurrected the helper under its old name
	for (const rel of PRODUCTION) {
		expect(stripComments(read(rel))).not.toMatch(/\bmediaProxyUrl\b/);
	}
});

test('the route carries the on-record note explaining the removal', () => {
	// Deleting a capability is an on-the-record decision in this repo: the next reader arrives at the
	// route, not at this guard, so the reason lives there. Asserted on the RAW source — the note is a
	// comment, and its presence is the point.
	const route = read(ROUTE);
	expect(route).toMatch(/ON THE RECORD/);
	expect(route).toMatch(/MediaStore\.url\(\)/);
	expect(route).toMatch(/no production caller|ZERO production callers/);
});

// ── non-vacuity floors (XR-VER-05): prove the scanner can answer BOTH ways ─────────────────────────

test('NON-VACUITY: the scanner finds the real call sites it is supposed to find', () => {
	// If these came back empty, every "has no consumer" verdict above would be meaningless.
	expect(productionCallSites('getRange')).toContain(ROUTE);
	expect(productionCallSites('size')).toContain(ROUTE);
	expect(productionCallSites('get')).toContain(ROUTE);
});

test('NON-VACUITY: the scanner reports ABSENCE for a member that does not exist', () => {
	// The sentinel is the deleted method itself plus a fabricated one. A scanner that matched anything
	// would find these too — and would have found `url` a caller back when it was still declared.
	expect(productionCallSites('url')).toEqual([]);
	expect(productionCallSites('presignedDirectUrlForTheTv')).toEqual([]);
});

test('NON-VACUITY: the production scan covers a real tree and resolves a store binding', () => {
	expect(PRODUCTION.length).toBeGreaterThan(100); // a walk over a wrong root yields a clean tree
	expect(PRODUCTION).toContain(ROUTE);
	expect(PRODUCTION).not.toContain(STORE); // an implementation may not satisfy its own declaration
	expect(PRODUCTION).not.toContain(OBJECT_STORE);
	// the route's binding is discovered rather than hardcoded — `const store = getApp().mediaStore`
	expect(storeBindings(stripComments(read(ROUTE)))).toContain('store');
});
