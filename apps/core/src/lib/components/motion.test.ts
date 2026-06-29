// M3-C7 guard: animations/transitions must be GPU-composited (transform/opacity/background/
// color/box-shadow only) — NEVER layout-triggering props (width/height/top/left/margin), which
// cause jank. Source-scan the component + route CSS. See docs/performance-and-feel.md §8.
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
