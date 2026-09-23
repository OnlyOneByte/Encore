// guard: `/` is the landing page. An unjoined visitor used to be bounced client-side to `/join` (`goto` in
// onMount); `/join` is retired and the home route renders the JoinLanding state in place. Mounting the full
// home route needs its whole WS/store machinery, so this pins both halves from the source instead.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const src = read('src/routes/+page.svelte');

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
	expect(code).toMatch(/import\s+JoinLanding\s+from\s+['"]\$lib\/components\/JoinLanding\.svelte['"]/);
	expect(code).toMatch(/<JoinLanding\b/);
	// The joined/unjoined split is a real branch on `me`: a guest (me === null) gets the landing, a singer the queue.
	expect(code).toMatch(/\{#if me\}/);
});
