/*
 * guard: the shadcn Field rhythm must come from somewhere, and that somewhere must be visible. See
 * docs/GUARDS.md#vendored-component-seams.
 *
 * shadcn splits a field into a WRAPPER that owns the rhythm (`Field` is `gap-3`, `Field.Group` `gap-7`)
 * and LEAVES with no vertical margin of their own. The settings page adopted the leaves and skipped the
 * wrappers — `Field.Label` 27 times and `Field.Description` 23 times with ZERO `Field`, `Field.Group` or
 * `Field.Set` — which on the registry's own CSS stacks 27 labels, 23 descriptions, 14 selects and 9
 * sliders flush. It renders correctly only because Encore hand-added `:global` margins INSIDE the two leaf
 * components, two files away from the page they rescue. Deleting either block is an obvious tidy-up, since
 * the registry has no such rule and a re-pull drops it, and it collapses 50 controls with every gate green.
 *
 * So: (1) while any file renders a leaf WITHOUT a wrapper, the leaves must keep supplying the rhythm,
 * pinned as the actual declarations; (2) the wrapper parts really are what carry a gap, since a re-vendor
 * that moves the gap onto the leaves ends premise (1); (3) every file rendering a leaf mounts a wrapper or
 * spaces the leaves itself. Adopting `Field`/`Field.Group` on the settings page is the real fix and would
 * let both `:global` blocks go — at which point arm (1) is retired on the record.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';

const SRC = srcDir;
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
 * Matched with a REGEX, not a substring: `markup.includes('<Field')` silently matched `<Field.Label` too,
 * so every leaf user looked like it had a wrapper, `wrapperless` came back empty, and arm 1 returned early
 * without checking anything — a guard that passed by never running, caught by mutation. The boundary is
 * what distinguishes the root from its own leaves.
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
		// If no file uses a leaf there is nothing to space and this arm is moot.
		expect(users.length).toBeGreaterThanOrEqual(2); // @nvf-floor users.length

		const wrapperless = users.filter(({ file }) => {
			const markup = markupOf(readFileSync(file, 'utf8'));
			return !WRAPPER_RE.test(markup);
		});
		if (wrapperless.length === 0) return; // wrappers adopted everywhere: this arm is retired by the code

		// Pinned as VALUES, not presence: a re-pull restoring the registry's marginless label drops the
		// declaration entirely.
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
		// And reachable: a SCOPED rule cannot style an element the component renders through a slot chain,
		// which is why these are `:global` to begin with.
		expect(label).toMatch(/:global\(\[data-slot='field-label'\]\)/);
		expect(desc).toMatch(/:global\(\[data-slot='field-description'\]\)/);
	});

	test('the wrapper parts are what carry a gap — the premise arm 1 rests on', () => {
		// If a re-vendor moves the rhythm onto the leaves, arm 1's reasoning no longer applies.
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
			// A local rhythm: a gap, a vertical margin, or a `:global` rule reaching a field slot.
			const spacesLocally =
				/(^|[;{\s])(gap|row-gap)\s*:/.test(style) ||
				/(^|[;{\s])margin(-block|-top|-bottom)?\s*:/.test(style) ||
				/:global\(\[data-slot='field-(label|description)'\]\)/.test(style);
			// Otherwise it relies on the leaf margins arm 1 pins, which is legal — arm 1 fails first if that
			// stops being true.
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
