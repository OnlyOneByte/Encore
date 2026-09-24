// guard: a singer's colour reaches CSS as a custom property, never string-concatenated. The phone header
// drew its avatar halo as `box-shadow: 0 0 0 3px {me.color}30`, which worked only because all eight presets
// were 6-digit hex; guests pick their own hue now, so a 3-digit hex, an `rgb()` or an `oklch()` makes the
// whole declaration invalid and the ring silently disappears. Derive with `color-mix()` instead, which
// accepts any syntax. See docs/GUARDS.md#colour-tokens-and-the-48-stop-palette.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';
import { stripComments, svelteFiles } from '@encore/test-support/scan';

const SRC = srcDir; // src

/**
 * The per-stop roles an interpolated colour can carry: a stop ships `fill`, `on_fill`, `accent_ink` and
 * `accent2`, and the trap is identical for each. Naming the roles rather than matching any identifier keeps
 * the scan off unrelated interpolations that merely end in two hex-ish characters.
 */
const COLOUR_ROLE = String.raw`(?:[cC]olor|[cC]olour|[fF]ill|[iI]nk|[aA]ccent|[hH]ue)`;

const FILES = [...svelteFiles(join(SRC, 'lib')), ...svelteFiles(join(SRC, 'routes'))];

// Both scans below assert `offenders` empty, so a walk returning nothing would pass vacuously.
test('the singer-colour scans actually read a non-empty surface', () => {
	expect(FILES.length).toBeGreaterThan(15); // @nvf-floor FILES.length
});

test('no hex alpha digits are concatenated onto an interpolated colour', () => {
	const offenders: string[] = [];
	const concat = new RegExp(String.raw`\{[^{}]*${COLOUR_ROLE}[^{}]*\}[0-9a-fA-F]{2}`, 'g');
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'), { markup: true, keepLine: true });
		// `}` closing an interpolation immediately followed by hex digits
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
		const src = stripComments(readFileSync(f, 'utf8'), { markup: true, keepLine: true });
		// the form that cannot be composed against
		for (const m of src.matchAll(bare)) {
			const line = src.slice(0, m.index!).split('\n').length;
			offenders.push(`${f.replace(SRC, 'src')}:${line}: ${m[0]} — set a custom property instead`);
		}
	}
	expect(offenders).toEqual([]);
});
