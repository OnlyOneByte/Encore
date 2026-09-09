/*
 * #827 SPIKE · RISK 2 — is the drawer's animation CSS-driven, and can the design guards see it?
 *
 * The issue's acceptance for risk 2 is a GREP, spelled out: "Given the copied drawer source, When
 * grepped for `transition:` / `in:` / `out:` / `animate:`, Then there are zero matches — or the spike
 * reports the collision rather than hiding it." This file is that grep, run as an assertion instead of
 * quoted in a PR body, so the answer cannot rot: a version bump that introduces a Svelte transition
 * directive reds here.
 *
 * The answer has two halves and they point opposite ways, which is why prose was the wrong medium:
 *
 *   GOOD  — zero `svelte/transition` and `svelte/animate` imports, and zero `in:` / `out:` / `animate:`
 *           directives anywhere in the shipped drawer. So there is no collision with
 *           `motion.test.ts`'s ban on Svelte transition directives. Motion really is CSS.
 *   BAD   — the CSS lives where no scan of `apps/core/src` can reach it: a 291-line `<style global>`
 *           inside `node_modules`, plus inline styles written from JS. `test-helpers.ts`'s SKIP_DIRS
 *           skips `node_modules` BY NAME, and `styleFiles` only collects `.svelte` / `.css`.
 *
 * WHY THIS IS A TEST AND NOT A NOTE. The durations are the part that matters to the design floors, and
 * they are unreachable AND unconfigurable: `TRANSITIONS.DURATION` is a module constant with no prop.
 * Pinning the number here is the only place the repo can notice it changing under a version bump.
 *
 * This file reads `node_modules` on purpose — the one place in the suite that does. That is not a
 * precedent for the design guards: it is a DEPENDENCY-SURFACE test, and it skips cleanly when the
 * package is absent so a fresh clone without the spike's dependency is not a red suite.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Resolve the package from either place bun may have linked it — `apps/core/node_modules` under the
 * isolated linker, or a hoisted root `node_modules`. Absent means SKIP, not fail: a clone that has not
 * installed the spike's dependency must not read as a broken suite.
 */
const CORE = join(import.meta.dir, '..', '..', '..');
const CANDIDATES = [join(CORE, 'node_modules', 'vaul-svelte'), join(CORE, '..', '..', 'node_modules', 'vaul-svelte')];
const VAUL = CANDIDATES.find((p) => existsSync(join(p, 'dist'))) ?? CANDIDATES[0];
const DIST = join(VAUL, 'dist');
const present = existsSync(DIST);

/** Every file under vaul's dist, recursively. */
function distFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const abs = join(dir, name);
		if (statSync(abs).isDirectory()) distFiles(abs, out);
		else out.push(abs);
	}
	return out;
}

describe.skipIf(!present)('#827 · vaul-svelte drawer, the dependency surface the spike measured', () => {
	test('the drawer ships NO Svelte transition or animate directives — so no motion.test.ts collision', () => {
		const files = distFiles(DIST);
		expect(files.length).toBeGreaterThan(10); // non-vacuity: an empty walk must not pass

		const offenders: string[] = [];
		for (const abs of files) {
			if (!/\.(svelte|js)$/.test(abs)) continue;
			const src = readFileSync(abs, 'utf8');
			const rel = abs.slice(VAUL.length + 1);
			// The imports are the decisive check: a Svelte transition directive cannot exist without one.
			if (/from\s+["']svelte\/(transition|animate)["']/.test(src)) {
				offenders.push(`${rel}: imports svelte/transition or svelte/animate`);
			}
			// And the directives themselves, on an element rather than in a property name. `in:`/`out:` are
			// spelled with a preceding `<` or whitespace inside a tag; requiring the `{` of the expression
			// keeps `transition:` CSS declarations and `onpointerout:` object keys out of the match.
			for (const d of ['transition', 'in', 'out', 'animate']) {
				if (new RegExp(String.raw`\s${d}:[a-zA-Z_$][\w$.]*\s*(=\s*\{|[/>\s])`).test(src)) {
					offenders.push(`${rel}: uses a Svelte \`${d}:\` directive`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test('its motion is CSS — and both the duration and the curve are unreachable constants', () => {
		// The curve MATCHES the incumbent's exactly; the duration does not, and there is no prop for it.
		// QueueSheet.svelte:200 is `transition: transform 0.28s cubic-bezier(0.32, 0.72, 0, 1)`.
		const constants = readFileSync(join(DIST, 'internal', 'constants.js'), 'utf8');
		expect(constants).toMatch(/DURATION:\s*0\.5\b/);
		expect(constants).toMatch(/EASE:\s*\[\s*0\.32,\s*0\.72,\s*0,\s*1\s*\]/);

		// The 291-line <style global> the design scans cannot see, and what it animates. `transform` and
		// `opacity` only — so the port would not violate motion.test.ts's layout-property ban either, if
		// the ban could reach it.
		const drawer = readFileSync(join(DIST, 'components', 'drawer', 'drawer.svelte'), 'utf8');
		expect(drawer).toContain('<style global>');
		const declared = [...drawer.matchAll(/transition:\s*([a-z-]+)/g)].map((m) => m[1]);
		expect(declared.length).toBeGreaterThan(0);
		expect([...new Set(declared)].sort()).toEqual(['opacity', 'transform']);
	});

	test('the sheet offset is an inline transform written from JS, which outranks any stylesheet rule', () => {
		// This is the finding that decides what a ported QueueSheet can still express in CSS: `--peek-h`
		// stops being read by a rule and has to be handed in as a px snap point instead.
		const snap = readFileSync(join(DIST, 'use-snap-points.svelte.js'), 'utf8');
		expect(snap).toMatch(/transform:\s*isVertical\([^)]*\)\s*\n?\s*\?\s*`translate3d\(0, \$\{dimension\}px, 0\)`/);
		// px snap points are supported, which is what makes a content-measured peek expressible at all.
		expect(snap).toContain('parseInt(snapPoint, 10)');
	});

	test('vaul does not declare bits-ui, the package its own accessibility layer imports', () => {
		// Not pedantry: `bun add vaul-svelte` alone produces a package that cannot resolve its own imports.
		// The spike hit this — the drawer would not build until bits-ui was installed separately — so the
		// adopting commit has to pin bits-ui itself, with nothing upstream stating a compatible range.
		const pkg = JSON.parse(readFileSync(join(VAUL, 'package.json'), 'utf8'));
		const declared = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
		expect(Object.keys(declared)).not.toContain('bits-ui');
		expect(readFileSync(join(DIST, 'components', 'drawer', 'drawer-content.svelte'), 'utf8')).toContain(
			'from "bits-ui"'
		);
	});

	test('its exports map has NO `default` condition — which is why bun test cannot load it', () => {
		/*
		 * THE FINDING THAT DECIDES WHAT A PORT COSTS THE MOUNT RUNG. `exports["."]` declares only `types`
		 * and `svelte`. Vite/SvelteKit apply the `svelte` condition, so the app builds; `bun test` does
		 * not, so the specifier resolves to nothing and every importer of the drawer becomes unloadable —
		 * reported as `Cannot find package 'vaul-svelte'`, which reads as an install problem rather than
		 * an exports-map one. `mount-rung.test.ts` (#822) imports every component that imports a `$app/*`
		 * module, and `routes/+page.svelte` both imports one and renders QueueSheet, so a real port takes
		 * the mount rung dark on the phone's densest surface.
		 *
		 * MEASURED REMEDY: `bun test --conditions=svelte` — the whole suite passes with it. That changes
		 * the repo's single gate command, which is why this spike reports it rather than doing it. A
		 * preload alias is NOT a substitute: the chain continues into `svelte-toolbelt` and `runed`, both
		 * of which are installed at TWO versions here (vaul's and bits-ui's), so a by-specifier map cannot
		 * tell them apart, and `build.onResolve` is never consulted for these imports (measured).
		 *
		 * If a version bump adds `default`, this test reds — and that is good news worth noticing.
		 */
		const pkg = JSON.parse(readFileSync(join(VAUL, 'package.json'), 'utf8'));
		const dot = pkg.exports?.['.'] ?? {};
		expect(Object.keys(dot).sort()).toEqual(['svelte', 'types']);
		expect(dot.default).toBeUndefined();
		// The contrast that proves it is the exports map and not the install: bits-ui ships `default`, and
		// resolves under plain `bun test`.
		const bits = CANDIDATES.map((p) => join(p, '..', 'bits-ui', 'package.json')).find((p) => existsSync(p));
		if (bits) expect(JSON.parse(readFileSync(bits, 'utf8')).exports?.['.']?.default).toBeTruthy();
	});
});
