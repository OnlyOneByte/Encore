// A route that calls itself dev-only must be GATED at runtime and PRESENT on disk. Caught: the component
// gallery opened with "dev-only gallery. Not a product surface." and had no gate at all, so it built and
// served in production and a guest who typed /components got fixture songs with invented singer names.
// It is not simply deleted because five guards read it as SOURCE for fixtures a real library rarely
// produces — a 60-character title, a row mid-pending-add, every singer colour at once, a lyrics card at
// the scale floor. Both halves are asserted here, so removing either reds.

import { test, expect } from 'bun:test';
import { at, read } from '@encore/test-support';
import { existsSync } from 'node:fs';

/** The dev-only surface and the server file that gates it. */
const GALLERY = 'src/routes/components/+page.svelte';
const GATE = 'src/routes/components/+page.server.ts';

/**
 * Every guard that reads the gallery as a fixture, listed EXPLICITLY rather than walked: a walk that
 * stopped finding one would take the check away with it.
 */
const FIXTURE_CONSUMERS = [
	'tests/guards/hygiene/queue-pending-add.test.ts',
	'tests/guards/hygiene/phone-home.test.ts',
	'tests/guards/design-system/processing-card-longname-fixture.test.ts',
	'tests/guards/design-system/lyrics-singer-colour-gallery.test.ts',
	'tests/guards/layout/lyrics-scale-gallery.test.ts'
];

test('the gallery route is gated to dev, not merely described as dev-only', () => {
	expect(existsSync(at(GATE)), `${GATE} is missing — the dev-only claim is unenforced again`).toBe(true);

	const gate = read(GATE);

	// The framework's own `dev`, not a hand-rolled NODE_ENV check: `$app/environment` is what SvelteKit
	// resolves for the build, so it cannot disagree with the bundle the user is served.
	expect(gate).toMatch(/import\s*\{\s*dev\s*\}\s*from\s*'\$app\/environment'/);

	// It must REFUSE, not merely branch.
	expect(gate).toMatch(/from\s*'@sveltejs\/kit'/);
	expect(gate).toMatch(/!dev/);
	expect(gate).toMatch(/error\(\s*404/);

	// The gallery itself still declares what it is, so the comment and the gate cannot drift apart.
	expect(read(GALLERY)).toMatch(/dev-only/i);
});

test('the gallery survives as a fixture surface, and every consumer still reads it', () => {
	expect(existsSync(at(GALLERY)), `${GALLERY} is gone — five guards read it as a fixture`).toBe(true);

	// A FLOOR, not an equality: a sixth guard adopting the gallery is welcome and must not red, while the
	// list quietly losing entries is the failure this catches.
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
