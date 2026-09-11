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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { svelteFiles } from './test-helpers';

const SRC = join(import.meta.dir, '..');

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

/**
 * The four per-stop roles an interpolated colour can now carry (XR-COL-24).
 *
 * The scans below used to look for the identifier `color` alone, which was complete while a stop was
 * ONE value. A stop now ships four — `fill`, `on_fill`, `accent_ink` and `accent2` — and the trap is
 * identical for every one of them: `{stop.onFill}30` works by accident for 6-digit hex and silently
 * drops the whole declaration for anything else. Naming the roles rather than matching any identifier
 * keeps the scan from firing on unrelated interpolations that merely end in two hex-ish characters.
 */
const COLOUR_ROLE = String.raw`(?:[cC]olor|[cC]olour|[fF]ill|[iI]nk|[aA]ccent|[hH]ue)`;

const FILES = [...svelteFiles(join(SRC, 'lib')), ...svelteFiles(join(SRC, 'routes'))];

// Non-vacuity floor: both scans below assert `offenders` empty, so a walk returning
// nothing would pass vacuously. ~25 svelte files today.
test('the singer-colour scans actually read a non-empty surface', () => {
	expect(FILES.length).toBeGreaterThan(15); // @nvf-floor FILES.length
});

test('no hex alpha digits are concatenated onto an interpolated colour', () => {
	const offenders: string[] = [];
	const concat = new RegExp(String.raw`\{[^{}]*${COLOUR_ROLE}[^{}]*\}[0-9a-fA-F]{2}`, 'g');
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		// `}` closing an interpolation immediately followed by hex digits inside a style attribute
		for (const m of src.matchAll(concat)) {
			const line = src.slice(0, m.index!).split('\n').length;
			offenders.push(`${f.replace(SRC, 'src')}:${line}: ${m[0]} — use color-mix() with the custom property`);
		}
	}
	expect(offenders).toEqual([]);
});

test('singer colour is passed as a custom property, not straight into background', () => {
	const offenders: string[] = [];
	const bare = new RegExp(String.raw`background:\s*\{[^{}]*${COLOUR_ROLE}[^{}]*\}`, 'g');
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		// `background: {something.color}` — the form that cannot be composed against
		for (const m of src.matchAll(bare)) {
			const line = src.slice(0, m.index!).split('\n').length;
			offenders.push(`${f.replace(SRC, 'src')}:${line}: ${m[0]} — set a custom property instead`);
		}
	}
	expect(offenders).toEqual([]);
});
