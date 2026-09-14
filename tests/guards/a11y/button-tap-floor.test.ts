//
// Guard 1 of 3 from the shadcn migration's own near-misses: NO CALL SITE MAY ASK FOR A BUTTON SIZE
// WHOSE BOX IS PINNED UNDER THE TAP FLOOR.
//
// THE BUG THIS BOUNDS, and it is not hypothetical — it shipped and was caught mid-migration. The
// registry's size axis is built for a 36px-default desktop UI, so measured against Encore's
// `--tap: 44px` every stock size is under the floor:
//
//     xs  h-6  24px      sm  h-8  32px      default  h-9  36px      lg  h-10  40px
//
// An inline control that is neither a square nor full-width had no compliant size to migrate onto, and
// `sm` is the obvious-looking choice. Migrating the reorder Done/Cancel, the search-escape "Show all N"
// and the back-to-queue control that way silently dropped four 44px hand-rolled controls to 32px.
// `size="tap"` was added for exactly that, and this guard is what stops the next person reaching for
// `sm` instead.
//
// THE RULE IS A MEASUREMENT, NOT A SPELLING. A size is non-compliant iff it PINS a fixed box under the
// floor — an `h-<n>` or `size-<n>` literal, where Tailwind's spacing multiplier makes the value
// `n * 4px`. Everything else is admitted, and that distinction is load-bearing rather than lenient:
//   · `block` / `tap` / `icon` defer to the tap token outright;
//   · `blockLg` pins NO height and pads with `--space-2xl`, so its box grows with its content and
//     clears the floor on padding alone — which the component already documents. An earlier draft of
//     this guard demanded the token and flagged `blockLg`, i.e. it flagged a compliant size. Measuring
//     the pinned height instead is what makes the guard agree with the thing it guards.
//
// WHY THIS ARM AND NOT THE OLD ONE. touch-targets.test.ts measures rules that size their own box in a
// PAGE stylesheet. A migrated control declares no such rule — its box comes from a utility string
// inside the component — so that guard cannot see it, and its `controlRulesSeen` floor was re-based
// downward precisely because the population is emptying into here. This is the successor it names.
//
// SCOPE. Phone and desktop-page surfaces. The TV tree is exempt by name: it has no pointer
// and its own type ladder, and `--tap` is a finger standard.
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

/** The `size:` axis only — the `variant:` axis also has a key called `default`, which is not a size. */
function sizeAxis(): Record<string, string> {
	const src = readFileSync(BUTTON, 'utf8');
	const block = /size:\s*\{([\s\S]*?)\n\t\t\t\}/.exec(src);
	expect(block, 'could not find the size axis in button.svelte').not.toBeNull();
	const out: Record<string, string> = {};
	for (const m of block![1]!.matchAll(/(?:^|\n)\s*'?([\w-]+)'?:\s*(?:\n\s*)?["']([^"']*)["']/g)) {
		out[m[1]!] = m[2]!;
	}
	// Non-vacuity: the parse really found the axis. An empty result would flag every call site, which
	// reads as a broken app rather than a broken guard.
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
	// Non-vacuity: the registry really does ship sub-floor sizes. If this set empties, the ban has
	// nothing to catch and should be retired rather than left looking authoritative.
	expect(tooShort.size, 'no sub-floor size exists any more — retire this ban on the record').toBeGreaterThan(0);

	const offenders: string[] = [];
	let sitesSeen = 0;
	for (const f of svelteFiles(SRC)) {
		const rel = f.slice(SRC.length + 1);
		if (EXEMPT.some((e) => rel.startsWith(e))) continue;
		// The component defines the axis; it is not a call site.
		if (rel.includes(join('components', 'ui'))) continue;
		const src = readFileSync(f, 'utf8');
		for (const m of src.matchAll(/<Button\b[^>]*?\bsize="([\w-]+)"/gs)) {
			sitesSeen++;
			if (tooShort.has(m[1]!)) {
				offenders.push(`${rel}: <Button size="${m[1]}"> — pinned at ${pinnedPx(axis[m[1]!]!)}px, under ${TAP_PX}px`);
			}
		}
	}

	// Non-vacuity: the walk really found call sites.
	expect(sitesSeen, 'found no <Button size="…"> call sites — the walk or the pattern broke').toBeGreaterThan(5);
	expect(
		offenders,
		`a Button call site asks for a size pinned under --tap (${TAP_PX}px). The stock sizes are xs 24, ` +
			'sm 32, default 36, lg 40. Use one that defers to the tap token or pins no height — see the ' +
			'`tap` size in button.svelte for the precedent and the reasoning.'
	).toEqual([]);
});

test('the four stock sizes really are under the floor, so the ban is not theatre', () => {
	// The premise this guard rests on, asserted rather than left in a comment: if a registry bump made
	// `sm` tall enough, this tells you to relax the ban instead of leaving a rule forbidding something
	// harmless.
	const axis = sizeAxis();
	for (const key of ['xs', 'sm', 'default', 'lg']) {
		const classes = axis[key];
		expect(classes, `no ${key} entry in the size axis`).toBeDefined();
		const px = pinnedPx(classes!);
		expect(px, `${key} pins no height, so this arm cannot judge it`).not.toBeNull();
		expect(px!, `${key} is no longer under the tap floor — relax the ban`).toBeLessThan(TAP_PX);
	}
});
