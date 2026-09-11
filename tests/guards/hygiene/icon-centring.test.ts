// guard: an icon-only control with a fixed box must actually centre its mark.
//
// THE BUG THIS EXISTS FOR. Icon.svelte renders `display:block`, so a mark placed inside a control
// with no centring context lands wherever the box's default layout drops it — off-centre inside a
// default inline-block <button>. That is the reported "the X in the remove button is off-centre":
// QueueRow's and ProcessingCard's `.act,.remove` set `width:44px; height:44px` but declared no
// `display:grid/flex` and no `place-items`, while every OTHER icon button in the app (SongRow's
// `.sing/.add`, ProfileSheet's `.x`, the route's `.ic/.gear`) does. It is statically detectable, so
// it should never be able to regress silently again.
//
// Scope: rules for an unambiguously icon-only control (a button-like selector) that pin BOTH a fixed
// width AND a fixed height in px. A control that lays its box out from content, or that only sizes one
// axis, has not created the trap this catches. Text buttons (labelled) are out of scope — they centre
// text by default; this is specifically about a block-level SVG mark.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appSrc } from '@encore/test-support';
import { svelteFiles } from '$lib/test-helpers';

const SRC = appSrc; // apps/core/src

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

/*
 * The phone surfaces, matching touch-targets.test.ts. The TV is enforced by its own scale test and its
 * marks are not icon-only tap targets.
 */
const FILES = [
	...svelteFiles(join(SRC, 'lib', 'components')),
	join(SRC, 'routes', '+page.svelte'),
	join(SRC, 'routes', 'settings', '+page.svelte')
];

// Non-vacuity floor: the scan below asserts `offenders` empty, so an empty FILES
// (a broken components walk) would pass vacuously. Components (9 since the landing-page rebuild added CodeEntry +
// JoinLanding) + 2 routes today; `/join` was retired, its join UI is now JoinLanding.
test('the icon-centring scan actually reads a non-empty surface', () => {
	expect(FILES.length).toBeGreaterThan(7); // @nvf-floor FILES.length
});

/*
 * The icon-only controls, by the class names they are addressed by. These carry a bare <Icon> and no
 * text child, so their mark's position depends entirely on the box's centring. A `.chip` or a labelled
 * `.btn-accent` is excluded: it centres real text, a different contract.
 */
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
			// A compound-class modifier (e.g. `.ic.play` — the control class glued straight to another
			// class) restyles a base rule and inherits its centring; only the base rule (`.ic`) owns the
			// centring contract, so a modifier that merely re-pins the box is not the trap.
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
