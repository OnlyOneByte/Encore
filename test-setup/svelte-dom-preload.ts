// Test harness for component tests under `bun test` (issue #698, decision B).
//
// Two jobs, both done at preload time so every `*.test.ts` in the suite can `import` a `.svelte`
// component and mount it:
//
//   1. Install a DOM. Svelte's client runtime (`mount`/`unmount`/effects) needs `document`,
//      `customElements`, `Node`, `HTMLElement`, `requestAnimationFrame`, `MutationObserver`, … .
//      happy-dom provides them; we copy the ones Svelte touches onto `globalThis`. This is the one
//      new devDependency decision B calls for — no second test RUNNER, `bun test` stays the one gate.
//   2. Load Svelte files. bun has no built-in Svelte loader, so a plugin compiles each `.svelte`
//      import (component) and each `.svelte.js`/`.svelte.ts` import (rune module) via
//      `svelte/compiler`. Rune modules are TypeScript here, so bun's transpiler strips the types
//      before `compileModule` runs.
//   3. Resolve SvelteKit's `$app/*` and `$env/*` virtual modules to real stub files under
//      `test-setup/kit/` (issue #822), so a ROUTE component — not just a leaf — can be imported.
//      SvelteKit synthesises those specifiers at build time and they resolve to nothing under
//      `bun test`, which is what previously made every route component unmountable.
//   4. Make the harness's unimplemented geometry APIs FAIL LOUDLY (issue #822, XR-VER-03). happy-dom
//      has NO LAYOUT ENGINE and returns an all-zero `DOMRect`, so the natural guard shape
//      `if (h > 0) expect(h).toBeGreaterThanOrEqual(44)` is silently vacuous. A geometry API that
//      cannot measure is made absent-with-a-message rather than wrong-with-a-zero.
//
// THE CAPABILITY BOUNDARY (XR-VER-01, written down in `docs/ux/04-verification.md`). This file is the
// MOUNT rung: mounting, the cascade, computed DECLARED values, effects and event handling. Box
// geometry, clipping/overflow, `env()`, `dvh`/`vh`, computed colour and computed font-size are NOT
// decidable here and belong to the LAYOUT rung — a real headless Chromium driven through
// `apps/core/e2e/cdp.mjs` (see `apps/core/e2e/HARNESS.md`).
//
// Tests get the CLIENT `mount`/`unmount`/`flushSync` from `test-setup/svelte-client.ts` (the bare
// `svelte` specifier resolves to the SERVER build under `bun test`, whose `mount()` throws). A
// preload plugin's `onResolve` does NOT intercept the test entry file's own bare imports, so the
// client entry is re-exported from a real on-disk module instead of remapped here.
//
// Wired via the root `bunfig.toml` `[test] preload`, so it runs ONCE before the suite and forks
// nothing. Zero production change; no existing test imports a Svelte file, so nothing else changes.
import { plugin, Transpiler } from 'bun';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Window } from 'happy-dom';
import { compile, compileModule } from 'svelte/compiler';
import { readFileSync } from 'node:fs';

// ── 1. DOM globals ────────────────────────────────────────────────────────────────────────────
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.document === 'undefined') {
	const win = new Window({ url: 'http://localhost/' });
	const names = [
		'document', 'customElements', 'Node', 'Element', 'HTMLElement', 'HTMLAudioElement',
		'HTMLMediaElement', 'Event', 'CustomEvent', 'DocumentFragment', 'Text', 'Comment',
		'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
		'navigator'
	];
	g.window = win;
	for (const name of names) {
		const v = (win as unknown as Record<string, unknown>)[name];
		if (v !== undefined && g[name] === undefined) g[name] = v;
	}
}

// ── 1b. Unimplemented geometry FAILS LOUDLY (#822, XR-VER-03) ─────────────────────────────────
// happy-dom 20.x has NO LAYOUT ENGINE, so every geometry read is a fabricated zero:
//   Element.js:795   getBoundingClientRect() { /* TODO: Not full implementation */ return new DOMRect(); }
//   Element.js:808   getClientRects()  — pushes that same all-zero rect into a list
//   Element.js:141   get scrollHeight() / :149 get scrollWidth()
//   HTMLElement.js:440 get offsetHeight() / :448 offsetWidth / :472 clientHeight / :480 clientWidth
// A zero a guard can mistake for a real measurement is worse than no API at all: it turns
// `expect(width).toBeGreaterThan(0)` into a permanent red nobody trusts and
// `if (width > 0) expect(...)` into a permanent SILENT GREEN. All SIX APIs XR-VER-03 enumerates are
// therefore replaced by a throw naming the rung and where the measurement CAN be taken.
//
// TWO PROTOTYPES, and that is load-bearing: `scrollWidth`/`scrollHeight` are defined on
// `Element.prototype` but the four offset/client accessors are defined on `HTMLElement.prototype`,
// which SHADOWS Element for every HTML element. Patching Element alone leaves `el.offsetHeight`
// returning 0 on exactly the elements a component test mounts.
//
// Deliberately OUTSIDE the DOM-install branch above: the aliasing plugin below is unconditional, and
// hardening only when THIS preload happened to install the DOM would fail silently under any other
// DOM provider. It reads the ACTIVE globals for the same reason, and says so if there are none.
const domCtors = ['Element', 'HTMLElement', 'SVGElement'] as const;
const rungPrototypes = domCtors
	.map((name) => (g[name] ?? (g.window as Record<string, unknown> | undefined)?.[name]) as
		{ prototype: Record<string, unknown> } | undefined)
	.filter((ctor): ctor is { prototype: Record<string, unknown> } => typeof ctor?.prototype === 'object')
	.map((ctor) => ctor.prototype);
if (rungPrototypes.length === 0) {
	throw new Error(
		'test-setup/svelte-dom-preload.ts: no Element/HTMLElement global to harden, so the mount rung ' +
		'would report fabricated zero geometry. A DOM must be installed before this point.'
	);
}

function unmeasurable(api: string): never {
	throw new Error(
		`${api} cannot measure on the MOUNT rung: happy-dom has no layout engine and fabricates a zero ` +
		`(node_modules/happy-dom/lib/nodes/element/Element.js, .../html-element/HTMLElement.js). Box ` +
		`geometry, clipping, env() and dvh/vh are decidable only on the LAYOUT rung — drive a real ` +
		`render through apps/core/e2e/cdp.mjs (see apps/core/e2e/HARNESS.md and ` +
		`docs/ux/04-verification.md, XR-VER-03). Do not read a zero here as a measurement.`
	);
}

for (const proto of rungPrototypes) {
	for (const method of ['getBoundingClientRect', 'getClientRects'] as const) {
		proto[method] = (): never => unmeasurable(`${method}()`);
	}
	for (const prop of ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight'] as const) {
		Object.defineProperty(proto, prop, {
			configurable: true,
			get: (): never => unmeasurable(prop)
		});
	}
}

// ── 3. SvelteKit virtual modules (#822) ───────────────────────────────────────────────────────
// The one place a `$app/*` or `$env/*` specifier is mapped. SvelteKit synthesises these at build
// time, so under `bun test` they resolve to nothing and a ROUTE component fails to load before any
// effect runs — which is why only leaf components with zero `$app` imports could mount.
//
// `build.module()` is the mechanism, NOT `onResolve`: a preload plugin's `onResolve` is never
// consulted for these specifiers (measured — the callback does not fire at all, for a component
// import or a test-entry import), while `build.module()` intercepts both. Each stub is re-exported
// from a real file under test-setup/kit/ rather than defined inline, so a test that imports the stub
// directly to drive or assert on it shares ONE module instance with the component under test.
const KIT_STUBS: Record<string, string> = {
	'$app/navigation': 'app-navigation.ts',
	'$app/state': 'app-state.ts',
	'$app/environment': 'app-environment.ts',
	'$env/dynamic/public': 'env-dynamic-public.ts'
};

// SvelteKit's remaining virtual modules. Nothing imports them today; they are registered so that
// the first component to import one fails with a message naming the fix instead of bun's bare
// "Cannot find module '$app/forms'", which reads as a broken component rather than a missing stub.
const KIT_UNSTUBBED = [
	'$app/forms', '$app/paths', '$app/server', '$app/stores',
	'$env/static/public', '$env/dynamic/private', '$env/static/private'
];

plugin({
	name: 'sveltekit-virtual-modules',
	setup(build) {
		for (const [specifier, file] of Object.entries(KIT_STUBS)) {
			// Plain interpolation rather than node:path — one fewer import in a file the whole suite
			// preloads, and bun accepts forward slashes on every platform it runs on.
			const stub = `${import.meta.dir}/kit/${file}`;
			build.module(specifier, () => ({
				contents: `export * from ${JSON.stringify(stub)};`,
				loader: 'ts'
			}));
		}
		for (const specifier of KIT_UNSTUBBED) {
			build.module(specifier, () => ({
				contents:
					`throw new Error(${JSON.stringify(
						`No test stub for SvelteKit virtual module '${specifier}'. Add one under test-setup/kit/ ` +
						`and register it in KIT_STUBS in test-setup/svelte-dom-preload.ts. Stubbed today: ` +
						`${Object.keys(KIT_STUBS).join(', ')}.`
					)});`,
				loader: 'ts'
			}));
		}
	}
});

// ── 3b. The bare `svelte` specifier, for DEPENDENCIES ────────────────────────────────────────
//
// #913 S3. Bits UI — which shadcn's Checkbox, Switch and Slider are built on — ships `.svelte` source
// that imports `getContext`/`setContext` from the bare `svelte` specifier. Under `bun test` that
// resolves to Svelte's SERVER build (the `default` export condition), whose context stack is not the
// one a client `mount()` populates. The result is `lifecycle_outside_component: getContext(...) can
// only be used during component initialisation` the moment such a component mounts — so BEFORE this,
// no Bits UI component could be mounted at all, and any route importing one failed the mount rung.
//
// `svelte-client.ts` already solves this for the test ENTRY file, and its comment explains why a
// plugin cannot: `onResolve` does not intercept the entry's own bare imports. A dependency's imports
// are a different case — those DO go through the plugin — so registering the specifier as a module
// redirects every non-entry `import … from 'svelte'` to the client entry the mount actually uses.
//
// Scoped to the EXACT specifier: `svelte/internal/client`, `svelte/compiler` and `svelte/server` are
// untouched, so a test that deliberately wants the server build still gets it.
const SVELTE_CLIENT_ENTRY = join(
	dirname(createRequire(import.meta.url).resolve('svelte/package.json')),
	'src/index-client.js'
);
plugin({
	name: 'svelte-bare-specifier-is-client',
	setup(build) {
		build.module('svelte', () => ({
			contents: `export * from ${JSON.stringify(SVELTE_CLIENT_ENTRY)};`,
			loader: 'js'
		}));
	}
});

// ── 4. Svelte loader ──────────────────────────────────────────────────────────────────────────
const transpiler = new Transpiler({ loader: 'ts' });

plugin({
	name: 'svelte-loader',
	setup(build) {
		// Rune modules: `.svelte.js` / `.svelte.ts`. Strip TS first, then compileModule.
		build.onLoad({ filter: /\.svelte\.(js|ts)$/ }, (args) => {
			const ts = readFileSync(args.path, 'utf8');
			const js = transpiler.transformSync(ts);
			const { js: out } = compileModule(js, { generate: 'client', dev: false, filename: args.path });
			return { contents: out.code, loader: 'js' };
		});
		// Components: `.svelte`. compile() handles the <script lang="ts"> block itself.
		build.onLoad({ filter: /\.svelte$/ }, (args) => {
			const source = readFileSync(args.path, 'utf8');
			const { js } = compile(source, { generate: 'client', dev: false, css: 'injected', filename: args.path });
			return { contents: js.code, loader: 'js' };
		});
	}
});
