// #834 Q2-A: `/` is the landing page. An unjoined visitor used to be bounced client-side to `/join`
// (`goto('/join')` in onMount); now `/join` is retired and the home route renders the JoinLanding state
// in place. This source-scan pins both halves — the bounce is GONE, and the unjoined branch renders
// JoinLanding — because mounting the full home route needs its whole WS/store machinery, which is a
// rung-L concern; the branch wiring itself is decidable from the source. A revert of either hunk reds.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = join(import.meta.dir, '..', 'routes', '+page.svelte');
const src = readFileSync(HOME, 'utf8');

// Strip comments so a `/join` mentioned in a comment (there is one, explaining the retirement) does not
// masquerade as a live bounce.
function stripComments(s: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return s.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}
const code = stripComments(src);

test('the home route no longer bounces an unjoined visitor to /join', () => {
	// The retired route must not be a navigation target anywhere in live code.
	expect(code).not.toMatch(/goto\(\s*['"`]\/join/);
});

test('the home route renders JoinLanding for the unjoined state', () => {
	// Imported…
	expect(code).toMatch(/import\s+JoinLanding\s+from\s+['"]\$lib\/components\/JoinLanding\.svelte['"]/);
	// …and rendered in the unjoined branch.
	expect(code).toMatch(/<JoinLanding\b/);
	// The joined/unjoined split is a real branch on `me`: the JoinLanding render sits in the `{:else}`
	// of an `{#if me}`, so a guest (me === null) gets the landing and a singer gets the queue.
	expect(code).toMatch(/\{#if me\}/);
});
