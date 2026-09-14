// guard: a route that calls itself dev-only must actually be gated, and the gallery must stay
// readable as a fixture.
//
// THE DEFECT THIS EXISTS FOR. `src/routes/components/+page.svelte` opened with "Component preview
// (dev-only gallery). Not a product surface." and had no gate of any kind — no `dev` check, no
// NODE_ENV branch, nothing. It was a plain SvelteKit route, so it built and served in production, and
// a guest who typed /components got a page of fixture songs with invented singer names. The comment
// was the only thing standing between that page and a visitor, and a comment enforces nothing.
//
// WHY THE FILE IS NOT SIMPLY DELETED. It is load-bearing test infrastructure. Five guards read it AS
// SOURCE and assert on its text, because it is the one place several components are instantiated with
// the awkward fixtures a real library would rarely produce: a 60-character song title, a queue row
// mid-pending-add, every singer colour at once, a lyrics card at the scale floor. Deleting the gallery
// deletes those fixtures. So the rule is: gated at runtime, present on disk.
//
// The two halves are asserted together on purpose. A future edit that removes the gate reds here, and
// so does one that removes the gallery the fixtures live in — and the second arm names the five
// consumers explicitly rather than walking for them, so a consumer dropping its read is a visible
// edit here instead of a quietly shorter list.

import { test, expect } from 'bun:test';
import { at, read } from '@encore/test-support';
import { existsSync } from 'node:fs';

/** The dev-only surface and the server file that gates it. */
const GALLERY = 'src/routes/components/+page.svelte';
const GATE = 'src/routes/components/+page.server.ts';

/**
 * Every guard that reads the gallery as a fixture. Explicit rather than a walk: the point is that a
 * fixture consumer cannot quietly stop consuming it, and a walk that stopped finding one would take
 * the check with it.
 */
const FIXTURE_CONSUMERS = [
	'tests/guards/hygiene/queue-pending-add.test.ts',
	'tests/guards/hygiene/phone-home-832.test.ts',
	'tests/guards/design-system/processing-card-longname-fixture.test.ts',
	'tests/guards/design-system/lyrics-singer-colour-gallery.test.ts',
	'tests/guards/layout/lyrics-scale-gallery.test.ts'
];

test('the gallery route is gated to dev, not merely described as dev-only', () => {
	expect(existsSync(at(GATE)), `${GATE} is missing — the dev-only claim is unenforced again`).toBe(true);

	const gate = read(GATE);

	// The gate must read the framework's own dev flag. A hand-rolled NODE_ENV check is not equivalent:
	// `$app/environment`'s `dev` is what SvelteKit itself resolves for the build, so it cannot disagree
	// with the bundle the user is actually served.
	expect(gate).toMatch(/import\s*\{\s*dev\s*\}\s*from\s*'\$app\/environment'/);

	// …and it must refuse, not merely branch. `error(404, …)` from @sveltejs/kit, guarded on !dev.
	expect(gate).toMatch(/from\s*'@sveltejs\/kit'/);
	expect(gate).toMatch(/!dev/);
	expect(gate).toMatch(/error\(\s*404/);

	// The gallery itself still declares what it is, so the comment and the gate cannot drift apart.
	expect(read(GALLERY)).toMatch(/dev-only/i);
});

test('the gallery survives as a fixture surface, and every consumer still reads it', () => {
	expect(existsSync(at(GALLERY)), `${GALLERY} is gone — five guards read it as a fixture`).toBe(true);

	// Non-vacuity: the list is the check, so an empty or shrunken list asserts nothing. A FLOOR rather
	// than an equality on purpose — a sixth guard adopting the gallery as a fixture is welcome and
	// should not red; the list quietly losing entries is the failure this catches.
	expect(FIXTURE_CONSUMERS.length).toBeGreaterThanOrEqual(5); // @nvf-floor FIXTURE_CONSUMERS.length

	const missing: string[] = [];
	const notReading: string[] = [];
	for (const consumer of FIXTURE_CONSUMERS) {
		if (!existsSync(at(consumer))) {
			missing.push(consumer);
			continue;
		}
		if (!read(consumer).includes(GALLERY)) notReading.push(consumer);
	}

	expect(missing, 'a named fixture consumer no longer exists — drop it from the list deliberately').toEqual([]);
	expect(
		notReading,
		'a guard listed here as a gallery fixture consumer no longer reads the gallery. Either it moved ' +
			'its fixture (remove it from this list, in this commit) or it lost a check it used to make.'
	).toEqual([]);
});
