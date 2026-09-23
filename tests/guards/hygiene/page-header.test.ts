import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { at } from '@encore/test-support';

/*
 * Route-inventory guard: every route page EXCEPT /tv and /components renders exactly one <h1> landmark
 * naming the page, plus a back affordance unless it is a root/entry surface. This is the line that was
 * missing when /stats and /metrics shipped as dead ends with no heading and no way back. The root `/`
 * carries the wordmark as its own <h1 class="brand"> and is an entry point, so it needs no back. The two
 * exemptions are decisions, not oversights: /tv is a chrome-free television surface, /components a
 * dev-only gallery of primitives using <h2> section heads.
 */

// Anchored on the repo root: a wrong walk root is the SILENT failure this whole tree exists to close.
const SRC = at('src/routes');

// Routes that are their own thing. Each entry states WHY, so an addition is a decision, not a drive-by.
const EXEMPT: Record<string, string> = {
	tv: 'television display surface, deliberately chrome-free',
	components: 'dev-only component gallery, not a product page'
};

// Root / entry surfaces: their h1 is the wordmark and they are the top of navigation, so no back is required.
const ROOTS = new Set(['/']);

// Every routed page under src/routes. The non-vacuity floor lives IN the walk so a third consumer inherits
// it: both consumers assert `offenders` EMPTY, so a moved `routes/` or a renamed `+page.svelte` made both
// pass with ZERO pages examined — the shape that let /stats and /metrics ship as dead ends in the first place.
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
	// 9 routed pages today; pin below. Plus the which-pages sentinel: the root cannot legitimately vanish, and
	// both EXEMPT entries must stay reachable, or the exemption test pins a decision about pages it cannot see.
	expect(out.length).toBeGreaterThanOrEqual(7); // @nvf-floor out.length
	const routes = out.map((p) => p.route);
	expect(routes).toContain('/');
	for (const ex of Object.keys(EXEMPT)) expect(routes).toContain(`/${ex}`);
	return out;
}

// The leaf directory name, e.g. /metrics/[mediaId] -> "[mediaId]", used only to test the exempt list.
const leaf = (route: string) => route.split('/').filter(Boolean).pop() ?? '';

// Exactly one h1 landmark: either a literal <h1> in the page, or exactly one PageHeader (which renders it).
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
	// Pin the decision itself: a third exemption must be argued here, which is where the "why" is recorded.
	expect(Object.keys(EXEMPT).sort()).toEqual(['components', 'tv']);
});
