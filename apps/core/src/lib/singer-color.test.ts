// guard: a singer's colour reaches CSS as a custom property, never string-concatenated.
//
// THE BUG THIS EXISTS FOR. The phone header used to draw the avatar halo as
//   box-shadow: 0 0 0 3px {me.color}30
// appending the hex alpha digits `30` onto the colour string. That worked only because all eight
// presets happened to be 6-digit hex. Guests pick their own hue now, and a 3-digit hex, an `rgb()` or
// an `oklch()` would produce invalid CSS and the halo would silently disappear — no error, no test
// failure, just a missing ring nobody notices until a guest asks why theirs looks different.
//
// The fix was to pass the colour as `--singer` and derive the halo with color-mix, which accepts any
// colour syntax. This guard keeps it that way.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..');

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...svelteFiles(p));
		else if (ent.name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

const FILES = [...svelteFiles(join(SRC, 'lib')), ...svelteFiles(join(SRC, 'routes'))];

// Non-vacuity floor (issue #453): both scans below assert `offenders` empty, so a walk returning
// nothing would pass vacuously. ~25 svelte files today.
test('the singer-colour scans actually read a non-empty surface', () => {
	expect(FILES.length).toBeGreaterThan(15);
});

test('no hex alpha digits are concatenated onto an interpolated colour', () => {
	const offenders: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		// `}` closing an interpolation immediately followed by hex digits inside a style attribute
		for (const m of src.matchAll(/\{[^{}]*(?:color|Color)[^{}]*\}[0-9a-fA-F]{2}/g)) {
			const line = src.slice(0, m.index!).split('\n').length;
			offenders.push(`${f.replace(SRC, 'src')}:${line}: ${m[0]} — use color-mix() with --singer`);
		}
	}
	expect(offenders).toEqual([]);
});

test('singer colour is passed as a custom property, not straight into background', () => {
	const offenders: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		// `background: {something.color}` — the form that cannot be composed against
		for (const m of src.matchAll(/background:\s*\{[^{}]*[cC]olor[^{}]*\}/g)) {
			const line = src.slice(0, m.index!).split('\n').length;
			offenders.push(`${f.replace(SRC, 'src')}:${line}: ${m[0]} — set --singer instead`);
		}
	}
	expect(offenders).toEqual([]);
});
