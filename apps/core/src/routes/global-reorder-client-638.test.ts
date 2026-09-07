// Issue #638: the host global-reorder CLIENT wiring in +page.svelte. That file is the SvelteKit phone
// entry point and has no unit harness (same class as server.ts and the join route guarded by
// session-cookie-attributes.test.ts), so this is a source-scan: it pins that the global-reorder path
// is actually wired, not merely that the store method exists. Reverting the +page.svelte hunks reds it.
//
// stripComments blanks // and /* */ so the explanatory prose naming the old per-singer path cannot
// satisfy or trip these assertions — only real code counts.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const src = stripComments(readFileSync(fileURLToPath(new URL('./+page.svelte', import.meta.url)), 'utf-8'));

test('+page.svelte derives a host-reorder gate from the room policy and membership', () => {
	// canHostReorder = canReorder && !!me?.id — a host gate on the existing player:control seam.
	expect(src).toMatch(/canHostReorder\s*=\s*\$derived\(\s*canReorder\s*&&\s*!!me\?\.id\s*\)/);
});

test('+page.svelte has a moveGlobal helper that pins across the WHOLE queue via the store', () => {
	// the helper computes a GLOBAL index and calls the store's pin path (not moveEntry / myPicks)
	expect(src).toMatch(/function moveGlobal\s*\(/);
	expect(src).toMatch(/function globalIdx\s*\(/);
	expect(src).toMatch(/store\?\.pinEntry\(/);
	// globalIdx indexes the whole queued list, not the singer's own picks
	expect(src).toMatch(/queued\.findIndex\(\(e\)\s*=>\s*e\.id\s*===\s*id\)/);
});

test('+page.svelte routes BOTH queued rows through moveGlobal when a host', () => {
	// The queue renders two row kinds — ProcessingCard (a cooking pick) and QueueRow (a ready pick) —
	// and the global-reorder path must be wired on BOTH, or a host cannot drag one of them. Count the
	// wiring rather than match once, so reverting EITHER row block (leaving the other) reds this.
	const count = (re: RegExp) => (src.match(re) ?? []).length;
	expect(count(/canHostReorder \? moveGlobal\(e\.id, -1\) : moveMine\(e\.id, -1\)/g)).toBe(2);
	expect(count(/canHostReorder \? moveGlobal\(e\.id, 1\) : moveMine\(e\.id, 1\)/g)).toBe(2);
	// the up/down enablement uses the GLOBAL index bounds under a host, on both rows
	expect(count(/canHostReorder \? globalIdx\(e\.id\) > 0 : myIdx\(e\.id\) > 0/g)).toBe(2);
	expect(count(/canHostReorder\s*\?\s*queued\.length > 1 :/g)).toBe(2);
});
