// guard: no call site may ask for a Button size whose box is PINNED under the tap floor. See
// docs/GUARDS.md#touch-targets.
//
// The registry's size axis is built for a 36px-default desktop UI, so against `--tap: 44px` every stock
// size is under the floor (xs 24, sm 32, default 36, lg 40). An inline control that is neither a square
// nor full-width had no compliant size to migrate onto and `sm` is the obvious-looking choice, which
// silently dropped four 44px hand-rolled controls to 32px. `size="tap"` exists for exactly that.
//
// THE RULE IS A MEASUREMENT, NOT A SPELLING: non-compliant iff it PINS a fixed box under the floor, as an
// `h-<n>`/`size-<n>` literal times Tailwind's 4px multiplier. `block`/`tap`/`icon` defer to the token;
// `blockLg` pins NO height and pads with `--space-2xl`, so its box grows with its content and clears the
// floor on padding alone — demanding the token instead would flag a compliant size.
//
// This is the successor touch-targets.test.ts names: that guard measures rules that size their own box in
// a PAGE stylesheet, and a migrated control declares no such rule (its box comes from a utility string
// inside the component), which is why its `controlRulesSeen` floor was re-based downward.
//
// SCOPE. Phone and desktop-page surfaces. The TV is exempt by name: no pointer, its own type ladder, and
// `--tap` is a finger standard.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';
import { svelteFiles } from '@encore/test-support/scan';

const SRC = srcDir;
const BUTTON = join(SRC, 'lib', 'components', 'ui', 'button', 'button.svelte');
const TAP_PX = 44;
/** Tailwind's spacing multiplier: `h-9` is 9 * 0.25rem. */
const STEP_PX = 4;

/** The TV is a display surface with no finger on it. */
const EXEMPT = [join('routes', 'tv'), join('lib', 'tv')];

/** The `size:` axis only — the `variant:` axis also has a `default` key, which is not a size. */
function sizeAxis(): Record<string, string> {
	const src = readFileSync(BUTTON, 'utf8');
	const block = /size:\s*\{([\s\S]*?)\n\t\t\t\}/.exec(src);
	expect(block, 'could not find the size axis in button.svelte').not.toBeNull();
	const out: Record<string, string> = {};
	for (const m of block![1]!.matchAll(/(?:^|\n)\s*'?([\w-]+)'?:\s*(?:\n\s*)?["']([^"']*)["']/g)) {
		out[m[1]!] = m[2]!;
	}
	// An empty parse would flag every call site, which reads as a broken app rather than a broken guard.
	expect(Object.keys(out).length, 'the size-axis parse found nothing').toBeGreaterThanOrEqual(6);
	return out;
}

/** The pinned box in px, or null when the size pins none (so its box grows with content). */
function pinnedPx(classes: string): number | null {
	const m = /\b(?:h|size)-(\d+)\b/.exec(classes);
	return m ? Number(m[1]) * STEP_PX : null;
}

test('no Button call site asks for a size whose box is pinned under the tap floor', () => {
	const axis = sizeAxis();
	const tooShort = new Set(
		Object.entries(axis)
			.filter(([, classes]) => {
				const px = pinnedPx(classes);
				return px !== null && px < TAP_PX;
			})
			.map(([name]) => name)
	);
	// If this set empties the ban has nothing to catch and should be retired rather than left looking authoritative.
	expect(tooShort.size, 'no sub-floor size exists any more — retire this ban on the record').toBeGreaterThan(0);

	const offenders: string[] = [];
	let sitesSeen = 0;
	for (const f of svelteFiles(SRC)) {
		const rel = f.slice(SRC.length + 1);
		if (EXEMPT.some((e) => rel.startsWith(e))) continue;
		// The component defines the axis rather than calling it.
		if (rel.includes(join('components', 'ui'))) continue;
		const src = readFileSync(f, 'utf8');
		for (const m of src.matchAll(/<Button\b[^>]*?\bsize="([\w-]+)"/gs)) {
			sitesSeen++;
			if (tooShort.has(m[1]!)) {
				offenders.push(`${rel}: <Button size="${m[1]}"> — pinned at ${pinnedPx(axis[m[1]!]!)}px, under ${TAP_PX}px`);
			}
		}
	}

	// The walk really found call sites.
	expect(sitesSeen, 'found no <Button size="…"> call sites — the walk or the pattern broke').toBeGreaterThan(5);
	expect(
		offenders,
		`a Button call site asks for a size pinned under --tap (${TAP_PX}px). The stock sizes are xs 24, ` +
			'sm 32, default 36, lg 40. Use one that defers to the tap token or pins no height — see the ' +
			'`tap` size in button.svelte for the precedent and the reasoning.'
	).toEqual([]);
});

test('the four stock sizes really are under the floor, so the ban is not theatre', () => {
	// The premise, asserted rather than left in a comment: a registry bump that made `sm` tall enough should
	// relax the ban rather than leave a rule forbidding something harmless.
	const axis = sizeAxis();
	for (const key of ['xs', 'sm', 'default', 'lg']) {
		const classes = axis[key];
		expect(classes, `no ${key} entry in the size axis`).toBeDefined();
		const px = pinnedPx(classes!);
		expect(px, `${key} pins no height, so this arm cannot judge it`).not.toBeNull();
		expect(px!, `${key} is no longer under the tap floor — relax the ban`).toBeLessThan(TAP_PX);
	}
});
