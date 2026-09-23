// A MediaStore member with no production caller is not a capability. See docs/GUARDS.md#media
import { test, expect } from 'bun:test';
import { read, filesUnder, relative, at } from '@encore/test-support';

const STORE = 'src/lib/server/media/store.ts';
const OBJECT_STORE = 'src/lib/server/media/object-store.ts';
const ROUTE = 'src/routes/media/[...path]/+server.ts';

// Blanks rather than deletes so reported offsets still line up. Load-bearing: the route's on-record note
// NAMES every deleted symbol, so without stripping it would trip the assertions it exists to explain.
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/** The `export interface MediaStore {... }` body, comments stripped, brace-sliced. */
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

/** Method members `name(` / `name?(` — optional included, since `size`/`getRange` are optional yet called. */
function methodMembers(body: string): string[] {
	return [...body.matchAll(/(?:^|\n)\s*(\w+)\??\s*\(/g)].map((m) => m[1]);
}

/** Non-method members (plain properties), so a future property cannot slip past unexamined. */
function propertyMembers(body: string): string[] {
	return [...body.matchAll(/(?:^|\n)\s*(?:readonly\s+)?(\w+)\??\s*:/g)].map((m) => m[1]);
}

// The app tree plus the Bun.serve entry, MINUS the files that declare and implement the interface: an
// implementation calling its own sibling satisfies nothing, the requirement is that a CONSUMER exists.
const PRODUCTION = [...filesUnder('src', ['.ts', '.svelte']), at('server.ts')]
	.map((abs) => relative(abs))
	.filter((rel) => rel !== STORE && rel !== OBJECT_STORE);

/**
 * Names a file binds a `MediaStore` instance to. A bare `.member(` scan is worthless (`.get(` matches every
 * `Map.get` in the tree), so a call counts only when its RECEIVER is demonstrably a media store: a binding
 * assigned from a `.mediaStore` expression, or the property accessed inline (`app.mediaStore.get(...)`).
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

// Members with no consumer, and why each is kept — not a parking space for the next unreachable capability.
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

// Never reinstatable, ledger or not: a store answers BYTES and the same-origin /media route is the sole URL
// builder, so re-adding one is a product decision about cross-origin playback that must be argued.
const FORBIDDEN_MEMBERS = ['url', 'presignedUrl', 'signedUrl', 'directUrl', 'publicUrl'];

test('every MediaStore METHOD has a production call site, or a ledger entry saying why not', () => {
	const members = methodMembers(mediaStoreInterfaceBody());
	expect(members).toContain('get'); // non-vacuity: a regex that stopped matching asserts nothing
	expect(members).toContain('size');
	expect(members).toContain('getRange');
	expect(members.length).toBeGreaterThanOrEqual(5);

	const unconsumed: string[] = [];
	for (const member of members) {
		if (productionCallSites(member).length === 0) unconsumed.push(member);
	}
	// EXACTLY the ledger: no more (an unreachable new member), no fewer (a stale entry).
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
	// A property cannot be "called", so one added here sits outside the caller rule: fail, so it is examined.
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
	// `mediaProxyUrl` built the string the route already builds; `presign` existed only to serve url().
	for (const src of [store, objectStore]) {
		expect(src).not.toMatch(/\bmediaProxyUrl\b/);
		expect(src).not.toMatch(/\bpresign\b/);
		expect(src).not.toMatch(/\bpresignExpiresIn\b/);
		expect(src).not.toMatch(/\bproxyUrls\b/);
		expect(src).not.toMatch(/\bObjectMediaStoreOpts\b/);
	}
	for (const rel of PRODUCTION) {
		expect(stripComments(read(rel))).not.toMatch(/\bmediaProxyUrl\b/);
	}
});

test('the route is the sole URL builder, and says so where the next reader arrives', () => {
	// The structural half first, so this arm cannot pass on prose alone: no production caller reaches a
	// URL-returning store member, which is what makes the same-origin route the only path to a ref.
	expect(productionCallSites('url'), 'a production caller for a URL-returning store member reappeared').toEqual([]);
	// Then the signpost, from RAW source since the note is a comment. A two-term alternation rather than a
	// pinned sentence, so rewording the note cannot red this for a reason unrelated to the claim.
	const route = read(ROUTE);
	expect(route, 'the route must still say every ref is served same-origin through it').toMatch(/same-origin/i);
	expect(route, 'and must still name what serving cross-origin instead would cost').toMatch(/cross-origin|CORS/i);
});

// These floors prove the scanner can answer BOTH ways; empty results make every verdict above meaningless.

test('NON-VACUITY: the scanner finds the real call sites it is supposed to find', () => {
	expect(productionCallSites('getRange')).toContain(ROUTE);
	expect(productionCallSites('size')).toContain(ROUTE);
	expect(productionCallSites('get')).toContain(ROUTE);
});

test('NON-VACUITY: the scanner reports ABSENCE for a member that does not exist', () => {
	// The deleted method plus a fabricated one: a scanner that matched anything would find both.
	expect(productionCallSites('url')).toEqual([]);
	expect(productionCallSites('presignedDirectUrlForTheTv')).toEqual([]);
});

test('NON-VACUITY: the production scan covers a real tree and resolves a store binding', () => {
	expect(PRODUCTION.length).toBeGreaterThan(100); // a walk over a wrong root yields a clean tree
	expect(PRODUCTION).toContain(ROUTE);
	expect(PRODUCTION).not.toContain(STORE); // an implementation may not satisfy its own declaration
	expect(PRODUCTION).not.toContain(OBJECT_STORE);
	// discovered, not hardcoded — the route writes `const store = getApp().mediaStore`
	expect(storeBindings(stripComments(read(ROUTE)))).toContain('store');
});
