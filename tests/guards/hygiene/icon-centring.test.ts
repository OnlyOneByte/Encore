// guard: an icon-only control with a fixed box must actually centre its mark. Icon.svelte renders `display:block`,
// so a mark inside a control with no centring context lands wherever the box's default layout drops it — the
// reported "the X in the remove button is off-centre": QueueRow's and ProcessingCard's `.act,.remove` pinned
// 44x44px but declared no grid/flex and no place-items, while every other icon button did. Scope: rules pinning
// BOTH axes in px — a content-sized or one-axis control has not created the trap.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';
import { svelteFiles } from '@encore/test-support/scan';

const SRC = srcDir; // src

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

// The phone surfaces, matching touch-targets.test.ts. The TV has its own scale test and no icon-only taps.
const FILES = [
	...svelteFiles(join(SRC, 'lib', 'components')),
	join(SRC, 'routes', '+page.svelte'),
	join(SRC, 'routes', 'settings', '+page.svelte')
];

// Non-vacuity floor: the scan below asserts `offenders` empty, so an empty FILES would pass vacuously.
test('the icon-centring scan actually reads a non-empty surface', () => {
	expect(FILES.length).toBeGreaterThan(7); // @nvf-floor FILES.length
});

// The icon-only controls, by the class names they are addressed by: these carry a bare <Icon> and no text child, so
// the mark's position depends entirely on the box. A labelled `.chip`/`.btn-accent` is excluded.
const ICON_CONTROL = /(^|[\s,>])(\.act\b|\.remove\b|\.sing\b|\.add\b|\.ic\b|\.gear\b|\.x\b|\.mic-btn\b)/;

/** Does a rule body establish a centring context for a block-level child? */
function centres(body: string): boolean {
	const grid = /display:\s*(grid|inline-grid|flex|inline-flex)/.test(body);
	if (!grid) return false;
	if (/place-items:\s*center/.test(body)) return true;
	// flex needs both axes named
	return /align-items:\s*center/.test(body) && /justify-content:\s*center/.test(body);
}

test('every icon-only control with a fixed box centres its mark', () => {
	const offenders: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			const sel = m[1]!.trim();
			const body = m[2]!;
			if (!ICON_CONTROL.test(sel)) continue;
			// A compound-class modifier (`.ic.play`) restyles a base rule and inherits its centring; only the base rule owns
			// the centring contract, so a modifier that merely re-pins the box is not the trap.
			if (/(\.act|\.remove|\.sing|\.add|\.ic|\.gear|\.x|\.mic-btn)\.[\w-]/.test(sel)) continue;
			// Only rules that pin BOTH axes to a fixed px box create the off-centre trap.
			const fixedW = /(^|[;\s])width:\s*[0-9.]+px/.test(body);
			const fixedH = /(^|[;\s])height:\s*[0-9.]+px/.test(body);
			if (!fixedW || !fixedH) continue;
			if (!centres(body)) {
				offenders.push(`${f.replace(SRC, 'src')}: ${sel} → fixed box without a centring context`);
			}
		}
	}
	expect(offenders).toEqual([]);
});
