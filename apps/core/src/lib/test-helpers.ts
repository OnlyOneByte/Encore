// Shared helpers for the source-scanning guard tests under src/lib.
//
// Dedup batch (#626, follows #618/#455): the recursive `.svelte` walker below was hand-copied
// verbatim into every guard that scans the component tree (motion, contrast, design-system,
// icon-centring, settings-scopes, singer-color, touch-targets, tv/stage-scale, …), and the 44px
// touch-target threshold `TAP` was re-declared in each touch guard. There is no production
// constant for 44 — the standard lives only in these tests — so it is single-sourced here rather
// than imported from src.
import { join } from 'node:path';
import { readdirSync } from 'node:fs';

/** Recursively collect every `.svelte` file under `dir` (absolute paths). */
export function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...svelteFiles(p));
		else if (ent.name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

/** The app's self-imposed minimum interactive touch-target size, in px (WCAG 2.5.8 is 24; the app
 *  set itself the stricter 44). Only the touch-target guards reference it. */
export const TAP = 44;
