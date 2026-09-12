/*
 * THE FIELD RHYTHM MUST COME FROM SOMEWHERE, AND IT MUST BE VISIBLE (the shadcn migration Phase 3).
 *
 * ── THE DEFECT THIS EXISTS FOR, WHICH SHIPPED ─────────────────────────────────────────────────────
 *
 * shadcn splits a field into a WRAPPER that owns the rhythm and LEAVES that carry no vertical margin of
 * their own: `Field` (the root) is `gap-3`, `Field.Group` is `gap-7`, while the registry's `Field.Label`
 * is `flex w-fit` and its `Field.Description` has only relational nudges (`last:mt-0`,
 * `nth-last-2:-mt-1`) tuned for sitting INSIDE that wrapper.
 *
 * the shadcn migration adopted the leaves and skipped the wrappers: `routes/settings/+page.svelte` uses `Field.Label`
 * 27 times and `Field.Description` 23 times with ZERO `Field`, `Field.Group` or `Field.Set`. On the
 * registry's own CSS that stacks 27 labels, 23 descriptions, 14 selects and 9 sliders flush. It did not
 * render that way only because Encore hand-added `:global` margins inside the two leaf components —
 * `field-label.svelte`'s `margin: var(--space-lg) 0 var(--space-2xs)` and `field-description.svelte`'s
 * `margin: var(--space-xs) 0 0`, each replacing a deleted `.field` / `.hint` rule.
 *
 * So the page is spaced by a substitution that lives two files away from the page it rescues, and
 * nothing recorded the dependency. Delete either `:global` block — an obvious tidy-up, since the
 * registry has no such rule and a re-pull would drop it — and 50 controls collapse with every gate
 * green. That is the failure this guard exists to make loud.
 *
 * ── WHAT THIS ASSERTS ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. The rhythm exists at all: while any file renders a Field leaf WITHOUT a Field wrapper, the leaf
 *    components must keep supplying it themselves. Pinned as the actual declarations, so removing one
 *    reds here rather than in a screenshot.
 * 2. The wrapper parts really are the things that carry a gap — if a re-vendor moves the gap onto the
 *    leaves, premise (1) stops being true and this file should be revisited rather than trusted.
 * 3. Every file rendering a leaf either mounts a wrapper, spaces the leaves itself, or is recorded.
 *
 * Adopting `Field` / `Field.Group` on the settings page is the real fix and would let both `:global`
 * blocks go — at which point arm (1) is retired on the record, not deleted quietly.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appSrc } from '@encore/test-support';

// The tree anchor comes from @encore/test-support rather than a relative walk: this guard moved
// from src/lib/ into tests/ during the test-architecture refactor, and a relative path would have
// to change again on the next move. `appSrc` is the repo's single source for 'where is src'.
const SRC = appSrc;
const UI_FIELD = join(SRC, 'lib', 'components', 'ui', 'field');

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) out.push(...svelteFiles(p));
		else if (p.endsWith('.svelte') && !p.includes('.harness.')) out.push(p);
	}
	return out;
}

function styleOf(src: string): string {
	return (src.match(/<style[\s\S]*?<\/style>/g) ?? []).join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ');
}
function markupOf(src: string): string {
	return src
		.replace(/<style[\s\S]*?<\/style>/g, ' ')
		.replace(/<script[\s\S]*?<\/script>/g, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ');
}

const LEAVES = ['Field.Label', 'Field.Description', 'Field.Title', 'Field.Error'] as const;
/*
 * The wrapper parts, matched with a REGEX rather than a substring.
 *
 * `markup.includes('<Field')` was the first attempt and it silently matched `<Field.Label` too, so every
 * leaf user looked like it already had a wrapper, `wrapperless` came back empty, and arm 1 returned early
 * without checking anything — a guard that passed by never running. Caught by mutation: deleting
 * field-label's margin left it green. The boundary is what makes the root distinguishable from its own
 * leaves: `<Field` followed by something that is NOT a dot.
 */
const WRAPPER_RE = /<Field(?![.\w])|<Field\.(Group|Set|Content)\b/;
const WRAPPER_NAMES = '<Field (root), Field.Group, Field.Set, Field.Content';

describe('the Field rhythm is supplied and visible', () => {
	const appFiles = svelteFiles(join(SRC, 'lib'))
		.concat(svelteFiles(join(SRC, 'routes')))
		.filter((f) => !f.startsWith(UI_FIELD));

	/** Files that render a leaf part at all. */
	function leafUsers(): { file: string; rel: string; leaves: string[] }[] {
		const out: { file: string; rel: string; leaves: string[] }[] = [];
		for (const f of appFiles) {
			const markup = markupOf(readFileSync(f, 'utf8'));
			const leaves = LEAVES.filter((l) => markup.includes(`<${l}`));
			if (leaves.length) out.push({ file: f, rel: f.slice(SRC.length + 1), leaves });
		}
		return out;
	}

	test('while any page uses a Field leaf without a wrapper, the leaves supply the rhythm themselves', () => {
		const users = leafUsers();
		// Non-vacuity: the leaves are really in use, or there is nothing to space and this arm is moot.
		expect(users.length).toBeGreaterThanOrEqual(2); // @nvf-floor users.length

		const wrapperless = users.filter(({ file }) => {
			const markup = markupOf(readFileSync(file, 'utf8'));
			return !WRAPPER_RE.test(markup);
		});
		if (wrapperless.length === 0) return; // wrappers adopted everywhere: this arm is retired by the code

		// The two substitutions that are actually holding those pages up. Pinned as VALUES, not presence:
		// a re-pull that restores the registry's marginless label would drop the declaration entirely.
		const label = styleOf(readFileSync(join(UI_FIELD, 'field-label.svelte'), 'utf8'));
		const desc = styleOf(readFileSync(join(UI_FIELD, 'field-description.svelte'), 'utf8'));
		const who = wrapperless.map((w) => w.rel).join(', ');
		expect(
			label,
			`${who} render Field.Label with no Field wrapper, so field-label.svelte's own margin is the ONLY thing separating them. It must declare a vertical margin.`
		).toMatch(/margin:\s*var\(--space-[\w-]+\)\s+0\s+var\(--space-[\w-]+\)/);
		expect(
			desc,
			`${who} render Field.Description with no Field wrapper, so field-description.svelte's own margin is the ONLY thing holding it off its control.`
		).toMatch(/margin:\s*var\(--space-[\w-]+\)\s+0\s+0/);
		// And they must be reachable: a SCOPED rule inside a component cannot style the element the
		// component itself renders through a slot chain, which is why these are :global to begin with.
		expect(label).toMatch(/:global\(\[data-slot='field-label'\]\)/);
		expect(desc).toMatch(/:global\(\[data-slot='field-description'\]\)/);
	});

	test('the wrapper parts are what carry a gap — the premise arm 1 rests on', () => {
		// If a re-vendor moves the rhythm onto the leaves, arm 1's reasoning no longer applies and this
		// file must be revisited rather than believed.
		expect(readFileSync(join(UI_FIELD, 'field.svelte'), 'utf8')).toMatch(/gap-\d/);
		expect(readFileSync(join(UI_FIELD, 'field-group.svelte'), 'utf8')).toMatch(/gap-\d/);
	});

	test('every file rendering a Field leaf mounts a wrapper or spaces the leaves itself', () => {
		let usersSeen = 0;
		const offenders: string[] = [];
		for (const { file, rel, leaves } of leafUsers()) {
			usersSeen++;
			const src = readFileSync(file, 'utf8');
			const markup = markupOf(src);
			if (WRAPPER_RE.test(markup)) continue;
			const style = styleOf(src);
			// A local rhythm: a gap, a vertical margin, or a :global rule reaching a field slot.
			const spacesLocally =
				/(^|[;{\s])(gap|row-gap)\s*:/.test(style) ||
				/(^|[;{\s])margin(-block|-top|-bottom)?\s*:/.test(style) ||
				/:global\(\[data-slot='field-(label|description)'\]\)/.test(style);
			// Or it relies on the leaf components' own margins, which arm 1 pins. That is legal but must be
			// TRUE of the leaves — arm 1 fails first if it stops being.
			if (spacesLocally) continue;
			offenders.push(
				`${rel}: renders ${leaves.join(', ')} with no Field wrapper (${WRAPPER_NAMES}) and no ` +
					`gap/margin of its own. It is relying entirely on ui/field's Encore-added :global margins — ` +
					`legal, but mount Field/Field.Group or declare the spacing here so the dependency is local.`
			);
		}
		expect(usersSeen).toBeGreaterThanOrEqual(2); // @nvf-floor usersSeen
		expect([...new Set(offenders)]).toEqual([]);
	});
});
