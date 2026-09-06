// guard: animations/transitions must be GPU-composited (transform/opacity/background/
// color/box-shadow only) — NEVER layout-triggering props (width/height/top/left/margin), which
// cause jank. Source-scan the component + route CSS. See docs/ARCHITECTURE.md.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LAYOUT_PROPS = ['width', 'height', 'top', 'left', 'right', 'bottom', 'margin', 'padding'];

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...svelteFiles(p));
		else if (ent.name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

// extract the property animated by each `transition:` / `animation:` declaration
function animatedProps(css: string): string[] {
	const props: string[] = [];
	// transition: <prop> ... ;  (first token after the colon is the property)
	for (const m of css.matchAll(/transition:\s*([a-z-]+)/g)) props.push(m[1]!);
	return props;
}

test('no transition animates a layout-triggering property (transform/opacity only)', () => {
	const files = [
		...svelteFiles(join(import.meta.dir, '..', '..', 'lib', 'components')),
		...svelteFiles(join(import.meta.dir, '..', '..', 'routes'))
	];
	const offenders: string[] = [];
	for (const f of files) {
		const css = readFileSync(f, 'utf8');
		for (const prop of animatedProps(css)) {
			if (LAYOUT_PROPS.includes(prop)) offenders.push(`${f}: transition: ${prop}`);
		}
	}
	expect(offenders).toEqual([]);
});

test('@keyframes use only transform/opacity', () => {
	const files = svelteFiles(join(import.meta.dir, '..', '..'));
	const bad: string[] = [];
	for (const f of files) {
		const css = readFileSync(f, 'utf8');
		for (const block of css.matchAll(/@keyframes[^{]+\{([\s\S]*?)\}\s*\}/g)) {
			const body = block[1]!;
			for (const lp of LAYOUT_PROPS) {
				// flag a layout prop used as an animated declaration inside keyframes
				if (new RegExp(`(^|[;{\\s])${lp}\\s*:`).test(body)) bad.push(`${f}: keyframe animates ${lp}`);
			}
		}
	}
	expect(bad).toEqual([]);
});

// guard (issue #148): every `animation:` declaration must honour Reduce Motion. An animation is
// suppressible if it is EITHER declared inside an `@media (prefers-reduced-motion: no-preference)`
// block, OR paired with an `@media (prefers-reduced-motion: reduce) { … animation: none }` reset in
// the SAME file. `animation: none` declarations are themselves the reset and are exempt. This closes
// the drift hazard behind #148: QueueRow's `.qrow { animation: pop … }` ran under Reduce Motion while
// app.css's guarded `.pop-in` helper had no callers. Source-decidable in the same shape as the scans
// above. Mutation proof: unguarding any animation (moving it out of the no-preference block, or
// dropping its reduce reset) reds this test.
function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, '');
}
// spans of every `@media (prefers-reduced-motion: no-preference)` block, as [start, end) offsets
function noPreferenceSpans(css: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	const re = /@media[^{]*prefers-reduced-motion:\s*no-preference[^{]*\{/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(css))) {
		// walk braces from the opening `{` to its match
		let depth = 1;
		let i = m.index + m[0].length;
		for (; i < css.length && depth > 0; i++) {
			if (css[i] === '{') depth++;
			else if (css[i] === '}') depth--;
		}
		spans.push([m.index, i]);
	}
	return spans;
}
function hasReduceReset(css: string): boolean {
	// an `@media (prefers-reduced-motion: reduce) { … animation: none … }` block anywhere in the file
	const re = /@media[^{]*prefers-reduced-motion:\s*reduce[^{]*\{([\s\S]*?)\}\s*\}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(css))) {
		if (/animation(-name)?:\s*none/.test(m[1]!)) return true;
	}
	return false;
}

test('every animation declaration honours prefers-reduced-motion', () => {
	const svelte = [
		...svelteFiles(join(import.meta.dir, '..', '..', 'lib')),
		...svelteFiles(join(import.meta.dir, '..', '..', 'routes'))
	];
	const files = [...svelte, join(import.meta.dir, '..', '..', 'app.css')];
	const offenders: string[] = [];
	for (const f of files) {
		const css = stripComments(readFileSync(f, 'utf8'));
		const spans = noPreferenceSpans(css);
		const reset = hasReduceReset(css);
		// match `animation:` / `animation-name:` shorthand declarations (not @keyframes, not the guard media queries)
		for (const m of css.matchAll(/(^|[;{\s])animation(-name)?:\s*([^;}]+)/g)) {
			const value = m[3]!.trim();
			if (/^none\b/.test(value)) continue; // the reset itself
			const at = m.index! + m[1]!.length;
			const guarded = spans.some(([s, e]) => at >= s && at < e);
			if (!guarded && !reset) offenders.push(`${f}: unguarded animation: ${value.slice(0, 40)}`);
		}
	}
	expect(offenders).toEqual([]);
});
