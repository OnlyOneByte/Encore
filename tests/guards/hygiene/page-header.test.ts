import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { at } from '@encore/test-support';

/*
 * Route-inventory guard for the cross-page consistency ruling — the standard the owner chose (option A):
 *
 *   Every route page EXCEPT /tv and /components renders exactly one <h1> landmark naming the page,
 *   plus a back affordance whenever it is not a root/entry surface.
 *
 * This is the line that was missing when /stats and /metrics shipped as dead ends with no heading
 * consistency and no way back — nothing asserted the invariant, so the next new page could repeat it.
 * The h1 + back now come from the shared PageHeader component; the ROOT surface (`/`) carries its
 * wordmark as its own <h1 class="brand"> and is an entry point, so it needs no back. (`/join` was such
 * a root too until the landing-page rebuild retired it — its join UI is now the unjoined branch of `/`.)
 *
 * The exemption list is the explicit decision, written down here so removing a page from it is a
 * conscious act a reviewer sees:
 *   - /tv       — a television display surface, deliberately chrome-free (root layout wraps it too).
 *   - /components — a dev-only gallery of primitives, not a product page; uses <h2> section heads only.
 */

// Anchored on the repo root, not on this file's own location: the old form was
// `at('apps/core/src/routes')`, which meant apps/core/src/routes only while this guard
// sat in apps/core/src/lib/ui. A wrong walk root is the SILENT failure this whole tree exists to close —
// the floor in `routePages()` below is the backstop, but the anchor is the fix.
const SRC = at('apps/core/src/routes');

// Routes that are their own thing. Each entry states WHY, so an addition is a decision, not a drive-by.
const EXEMPT: Record<string, string> = {
	tv: 'television display surface, deliberately chrome-free',
	components: 'dev-only component gallery, not a product page'
};

// Root / entry surfaces: they carry the Encore wordmark as their h1 and are the top of navigation,
// so the invariant requires their h1 but NOT a back affordance.
const ROOTS = new Set(['/']);

/**
 * Every routed page under src/routes, as { route, file, src }.
 *
 * Non-vacuity floor (XR-VER-05). This walk had NO floor, and both consumers assert
 * `offenders` EMPTY (`:70` the single-h1 rule, `:80` the back affordance) — so a moved `routes/`, a
 * renamed `+page.svelte`, or a walk root typo made both pass with ZERO pages examined. That is the
 * exact shape that let /stats and /metrics ship as dead ends in the first place, reappearing one level
 * up: nothing asserted the guard was still looking at anything.
 *
 * The floor lives IN the walk, not in each test, so a third consumer inherits it.
 *
 * A firing floor is a FINDING, never a number to adjust — see XR-VER-06 and
 * `non-vacuity-floors.test.ts` (cited by bare filename: a `../` pointer was arithmetic about where
 * this test lived, and it stopped resolving the moment the file moved).
 */
function routePages(): { route: string; file: string; src: string }[] {
	const out: { route: string; file: string; src: string }[] = [];
	const walk = (dir: string, urlParts: string[]) => {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (ent.isDirectory()) walk(join(dir, ent.name), [...urlParts, ent.name]);
			else if (ent.name === '+page.svelte') {
				const route = '/' + urlParts.join('/');
				out.push({
					route: route === '/' ? '/' : route.replace(/\/$/, ''),
					file: join(dir, ent.name),
					src: readFileSync(join(dir, ent.name), 'utf8')
				});
			}
		}
	};
	walk(SRC, []);
	// 9 routed pages today; pin below. Plus the which-pages sentinel: the root page is the one route
	// that cannot legitimately disappear, and both EXEMPT entries must still be reachable by the walk,
	// or the exemption test at :90 is pinning a decision about pages this scan can no longer see.
	expect(out.length).toBeGreaterThanOrEqual(7); // @nvf-floor out.length
	const routes = out.map((p) => p.route);
	expect(routes).toContain('/');
	for (const ex of Object.keys(EXEMPT)) expect(routes).toContain(`/${ex}`);
	return out;
}

// The leaf directory name, e.g. /metrics/[mediaId] -> "[mediaId]", used only to test the exempt list.
const leaf = (route: string) => route.split('/').filter(Boolean).pop() ?? '';

// Does the page paint exactly one h1 landmark? Either a literal <h1 ...> in the page, or exactly one
// PageHeader (which renders the single h1). We count both and require the total to be exactly one.
function h1Count(src: string): number {
	const literal = (src.match(/<h1[\s>]/g) ?? []).length;
	const viaHeader = (src.match(/<PageHeader[\s\n]/g) ?? []).length;
	return literal + viaHeader;
}

// A back affordance = a PageHeader given a `back=` target, or a raw class="back" control.
function hasBack(src: string): boolean {
	return /<PageHeader[\s\S]*?\bback=/.test(src) || /class="back"/.test(src);
}

test('every non-exempt route renders exactly one h1 landmark', () => {
	const offenders: string[] = [];
	for (const p of routePages()) {
		if (EXEMPT[leaf(p.route)]) continue;
		const n = h1Count(p.src);
		if (n !== 1) offenders.push(`${p.route} has ${n} h1 landmarks (want exactly 1)`);
	}
	expect(offenders).toEqual([]);
});

test('every non-exempt, non-root route offers a back affordance', () => {
	const offenders: string[] = [];
	for (const p of routePages()) {
		if (EXEMPT[leaf(p.route)]) continue;
		if (ROOTS.has(p.route)) continue;
		if (!hasBack(p.src)) offenders.push(`${p.route} has no back affordance (PageHeader back= or class="back")`);
	}
	expect(offenders).toEqual([]);
});

test('the exemption list is exactly the two pages we decided (/tv, /components)', () => {
	// Pin the decision itself: if someone adds a third exemption they must edit this assertion, which
	// is where the "why" is recorded. Silently exempting a new page is how /stats slipped through once.
	expect(Object.keys(EXEMPT).sort()).toEqual(['components', 'tv']);
});
