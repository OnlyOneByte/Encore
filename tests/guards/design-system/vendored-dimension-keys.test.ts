// guard: a vendored component may not size itself through a NAMED scale key. See
// docs/GUARDS.md#tailwind-v4-toolchain.
//
// `alert-dialog` arrived from the registry with `data-[size=default]:max-w-xs` and rendered as a
// SIX-PIXEL-WIDE strip with its text overflowing both sides. Tailwind resolves `max-w-<key>` against the
// `--container-*` namespace, which this app does not bridge, so it fell through to the SPACING namespace,
// which it does, and emitted `max-width: var(--space-xs)` — 6px. It passed eslint, `svelte-check` 0/0 and
// 2799 tests; only a screenshot found it. That is the signature of the class: a named key resolving
// through the WRONG namespace to a real number off by an order of magnitude rather than an error.
//
// Arbitrary values (`max-w-[26rem]`, `w-[calc(100vw-2*var(--space-4xl))]`), fractions and keywords
// (`w-full`, `w-1/2`, `h-auto`) resolve nothing through a namespace and cannot land in the wrong one.
// Numeric steps are permitted here and policed by a11y/button-tap-floor.test.ts, which measures what they
// compute to — banning them here would duplicate that judgment in a second, disagreeing place.
//
// SCOPE. Only the vendored tree: `app.css` sets `source(none)` with a single `@source` over
// `components/ui`, so a utility written in a page is emitted nowhere.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';
import { svelteFiles } from '@encore/test-support/scan';

const SRC = srcDir;
const VENDORED = join(SRC, 'lib', 'components', 'ui');

/** Dimension utilities that resolve a NAMED key through a namespace. */
const DIMENSION = /\b(?:max-w|min-w|max-h|min-h|w|h|size)-([a-z][a-z0-9]*)\b/g;

/**
 * Keys that are NOT scale lookups, so they cannot land in the wrong namespace. `tap` is Encore's own
 * bridged key (`--spacing-tap`), the single value deliberately routed through the spacing namespace, and
 * `button-tap-floor.test.ts` depends on `min-h-tap` / `size-tap` meaning exactly that.
 */
const SAFE = new Set(['full', 'auto', 'screen', 'min', 'max', 'fit', 'px', 'dvh', 'dvw', 'svh', 'lvh', 'tap']);

test('no vendored component sizes itself through a named scale key', () => {
	const offenders: string[] = [];
	let filesSeen = 0;
	let utilsSeen = 0;

	for (const f of svelteFiles(VENDORED)) {
		filesSeen++;
		const src = readFileSync(f, 'utf8')
			// Prose explaining this rule must not trip it.
			.replace(/<!--[\s\S]*?-->/g, ' ')
			.replace(/\/\*[\s\S]*?\*\//g, ' ');
		for (const m of src.matchAll(DIMENSION)) {
			const key = m[1]!;
			utilsSeen++;
			if (SAFE.has(key)) continue;
			// A numeric step is a different judgment, owned by button-tap-floor.test.ts.
			if (/^\d+$/.test(key)) continue;
			offenders.push(
				`${f.slice(SRC.length + 1)}: \`${m[0]}\` resolves the key "${key}" through a namespace. ` +
					`Use an arbitrary value instead — e.g. \`${m[0].replace(`-${key}`, '-[…]')}\`.`
			);
		}
	}

	// Both halves: the walk found the vendored tree, and the pattern matches the utilities it polices.
	// Either at zero reports a clean tree from a broken scan.
	expect(filesSeen, 'found no vendored components — the walk broke').toBeGreaterThan(20);
	expect(utilsSeen, 'the dimension pattern matched nothing — it broke').toBeGreaterThan(5);

	expect(
		offenders,
		'a vendored component sizes itself with a named scale key. Tailwind resolves these through a ' +
			'namespace, and this app bridges t-shirt SPACING keys while NOT bridging the container scale — ' +
			'so `max-w-xs` silently emitted `max-width: var(--space-xs)`, six pixels, and passed every ' +
			'other gate. Arbitrary values resolve nothing and cannot land in the wrong namespace.'
	).toEqual([]);
});
