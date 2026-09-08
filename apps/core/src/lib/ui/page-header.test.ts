import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Route-inventory guard for issue #644 — the standard the owner chose (option A):
 *
 *   Every route page EXCEPT /tv and /components renders exactly one <h1> landmark naming the page,
 *   plus a back affordance whenever it is not a root/entry surface.
 *
 * This is the line that was missing when /stats and /metrics shipped as dead ends with no heading
 * consistency and no way back — nothing asserted the invariant, so the next new page could repeat it.
 * The h1 + back now come from the shared PageHeader component; the ROOT surfaces (/ and /join) carry
 * their wordmark as their own <h1 class="brand"> and are entry points, so they need no back.
 *
 * The exemption list is the explicit decision, written down here so removing a page from it is a
 * conscious act a reviewer sees:
 *   - /tv       — a television display surface, deliberately chrome-free (root layout wraps it too).
 *   - /components — a dev-only gallery of primitives, not a product page; uses <h2> section heads only.
 */

const SRC = join(import.meta.dir, '..', '..', 'routes');

// Routes that are their own thing. Each entry states WHY, so an addition is a decision, not a drive-by.
const EXEMPT: Record<string, string> = {
	tv: 'television display surface, deliberately chrome-free',
	components: 'dev-only component gallery, not a product page'
};

// Root / entry surfaces: they carry the Encore wordmark as their h1 and are the top of navigation,
// so the invariant requires their h1 but NOT a back affordance.
const ROOTS = new Set(['/', '/join']);

/** Every routed page under src/routes, as { route, file, src }. */
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
