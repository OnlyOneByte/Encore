/*
 * COPIED-IN COMPONENTS CARRY NO FOREIGN THEME (#913 S1).
 *
 * shadcn-svelte's registry ships components styled against ITS theme vocabulary — `bg-primary`,
 * `text-primary-foreground`, `border-ring`, `bg-muted`, `bg-destructive`, `--radius-md`. None of those
 * exist in this app and none can be made to: `app.css`'s `@theme inline` registers no colour on
 * purpose, because minting is all-or-nothing per namespace and `--color-accent` would hand out
 * `text-accent` beside `bg-accent` (`--accent` is 3.10:1 as ink on `--card2`, below AA — the whole
 * reason `--accent-ink` is a separate token).
 *
 * A component left carrying those class names does not fail loudly. Tailwind emits nothing for an
 * unknown theme key, so the utility is simply absent and the element renders unstyled or
 * half-styled — which looks like a design choice in a screenshot. That is the failure this guard
 * exists to make impossible, and it is the same class as every other silent-green defect this repo
 * has hit: a rule that stops applying looks identical to a rule that is satisfied.
 *
 * The floor at the bottom is the non-vacuity arm. This directory holds one component today; the
 * assertions above pass trivially on an empty directory, so the count is what tells a reader the scan
 * actually reached something. Registered in `non-vacuity-floors.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(import.meta.dir, 'components', 'ui');

/** Every `.svelte` file under the copy-in target, recursively. */
function uiComponents(dir = UI, out: string[] = []): string[] {
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) uiComponents(p, out);
		else if (ent.name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

/**
 * The component with its COMMENTARY REMOVED.
 *
 * This is load-bearing, and it caught itself: the first version of this guard scanned raw text and
 * failed on `button.svelte`'s own header comment, which names `bg-primary` and `border-ring` precisely
 * to explain why they were removed. A guard that reads prose as code makes documenting the rule a
 * violation of it — so the honest subject is what the component USES, never what it mentions.
 */
function code(src: string): string {
	return src
		.replace(/<!--[\s\S]*?-->/g, '') // Svelte markup comments
		.replace(/\/\*[\s\S]*?\*\//g, '') // block comments, in <script> and <style>
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments, sparing `https://`
}

/**
 * Theme keys shadcn ships that this app does not define. Deliberately the SEMANTIC colour names and
 * the radius scale — not a blanket ban on Tailwind utilities, which are the intended mechanism inside
 * this directory.
 */
const FOREIGN = [
	'primary',
	'primary-foreground',
	'secondary',
	'secondary-foreground',
	'destructive',
	'destructive-foreground',
	'muted',
	'muted-foreground',
	'accent-foreground',
	'popover',
	'popover-foreground',
	'background',
	'foreground',
	'border',
	'input',
	'ring',
	'sidebar',
	'card-foreground'
];

/** `bg-primary`, `text-muted-foreground`, `border-ring`, and the `/opacity` and `dark:` forms. */
const foreignRe = new RegExp(
	`\\b(?:dark:)?(?:bg|text|border|ring|fill|stroke|from|via|to|outline|divide|shadow|accent|caret|decoration|placeholder)-(?:${FOREIGN.join('|')})\\b`,
	'g'
);

describe('#913 a copied-in component references no theme this app does not define', () => {
	const files = uiComponents();

	test('no shadcn semantic colour utility survives the repointing', () => {
		const offenders: string[] = [];
		for (const f of files) {
			const src = code(readFileSync(f, 'utf8'));
			for (const m of src.matchAll(foreignRe)) {
				offenders.push(`${f.slice(f.indexOf('components/ui'))}: ${m[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test('no `rounded-*` scale utility, because this app has not bridged its radius tokens', () => {
		/*
		 * `app.css` explains why at its `@theme inline` block: this app's radius tokens are ALREADY
		 * named `--radius-sm` / `--radius-md` / `--radius-xs` / `--radius-btn` / `--radius-pill`, which
		 * is Tailwind's own namespace, so a bridge entry would be `--radius-sm: var(--radius-sm)` — a
		 * self-reference that resolves to nothing and paints nothing. Registering them properly means
		 * MOVING the five declarations out of `:root` and into `@theme`, which that comment reserves for
		 * "one commit, deliberately, with the guards re-run". Until someone does that, radius arrives as
		 * an arbitrary value: `rounded-[var(--radius-btn)]`.
		 */
		const offenders: string[] = [];
		for (const f of files) {
			const src = code(readFileSync(f, 'utf8'));
			for (const m of src.matchAll(/\brounded-(?!\[)[a-z0-9]+/g)) {
				offenders.push(`${f.slice(f.indexOf('components/ui'))}: ${m[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test('non-vacuity: the scan reached at least one component', () => {
		expect(files.length).toBeGreaterThanOrEqual(1); // @nvf-floor files.length
	});

	test('the comment stripper does not blind the scan to real class strings', () => {
		// The mutation that proves this guard can still fail. Without this, stripping comments could be
		// widened until nothing is scanned and every arm above passes vacuously.
		const mutant = code('<script>/* bg-primary in prose */</script>\n<button class="bg-primary">x</button>');
		expect(mutant).not.toContain('in prose');
		expect([...mutant.matchAll(foreignRe)].map((m) => m[0])).toEqual(['bg-primary']);
	});
});
