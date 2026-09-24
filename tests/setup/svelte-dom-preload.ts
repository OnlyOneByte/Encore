// The component-test harness, wired via the root `bunfig.toml` `[test] preload` so it runs ONCE before the suite. Four
// jobs, all at preload time, so any `*.test.ts` can import and mount a `.svelte` file: install happy-dom on
// `globalThis`; compile `.svelte` components and `.svelte.js`/`.svelte.ts` rune modules; resolve SvelteKit's
// build-time `$app/*` and `$env/*` virtual modules to real stubs under `tests/setup/kit/`, without which a ROUTE
// component fails to load before any effect runs; and make the unimplemented geometry APIs FAIL LOUDLY (see 1b).
//
// THE CAPABILITY BOUNDARY. This is the MOUNT rung: mounting, the cascade, computed DECLARED values, effects, event
// handling. Box geometry, clipping/overflow, `env()`, `dvh`/`vh`, computed colour and computed font-size are NOT
// decidable here and belong to the LAYOUT rung — real headless Chromium via `tests/e2e/driver.mjs`.
//
// Tests get the CLIENT `mount`/`unmount`/`flushSync` from `tests/setup/svelte-client.ts`, because the bare `svelte`
// specifier resolves to the SERVER build under `bun test` and its `mount()` throws. That one must be a real on-disk
// module: a preload plugin's `onResolve` does not intercept the test entry file's own bare imports.
import { plugin, Transpiler } from 'bun';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Window } from 'happy-dom';
import { compile, compileModule } from 'svelte/compiler';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Walking up for `bunfig.toml` — the SAME file bun uses to locate this preload, so the runner and this module agree by
 * construction, where a `join(import.meta.dir, '..', …)` hop silently re-points when the harness moves. Inlined rather
 * than imported from `@encore/test-support`: this file IS the preload, so no tsconfig path alias exists yet.
 */
const REPO_ROOT = (() => {
	let dir = import.meta.dir;
	for (let i = 0; i < 10; i += 1) {
		if (existsSync(join(dir, 'bunfig.toml'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		`test-setup: no bunfig.toml above ${import.meta.dir}. The preload locates the repo root by that ` +
			`marker, because it is the same file bun uses to find this preload. If the harness moved, it has to ` +
			`stay somewhere under the root that holds bunfig.toml.`
	);
})();

// 1. DOM globals
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.document === 'undefined') {
	const win = new Window({ url: 'http://localhost/' });
	const names = [
		'document',
		'customElements',
		'Node',
		'Element',
		'HTMLElement',
		'HTMLAudioElement',
		'HTMLMediaElement',
		'Event',
		'CustomEvent',
		'DocumentFragment',
		'Text',
		'Comment',
		'MutationObserver',
		'requestAnimationFrame',
		'cancelAnimationFrame',
		'getComputedStyle',
		'navigator'
	];
	g.window = win;
	for (const name of names) {
		const v = (win as unknown as Record<string, unknown>)[name];
		if (v !== undefined && g[name] === undefined) g[name] = v;
	}
}

// 1b. Unimplemented geometry FAILS LOUDLY. happy-dom fabricates a zero for every geometry read, which turns
// `expect(w).toBeGreaterThan(0)` into a permanent red and `if (w > 0) expect(…)` into a permanent SILENT GREEN. All
// six APIs throw, naming the rung that can measure.
//
// TWO PROTOTYPES, load-bearing: `scrollWidth`/`scrollHeight` live on `Element.prototype` but the four offset/client
// accessors live on `HTMLElement.prototype`, which SHADOWS Element — patching Element alone leaves `el.offsetHeight`
// returning 0 on exactly the elements a component test mounts.
//
// Deliberately OUTSIDE the DOM-install branch above, reading the ACTIVE globals: the aliasing plugins below are
// unconditional, so hardening only when THIS preload installed the DOM would fail silently under another provider.
const domCtors = ['Element', 'HTMLElement', 'SVGElement'] as const;
const rungPrototypes = domCtors
	.map(
		(name) =>
			(g[name] ?? (g.window as Record<string, unknown> | undefined)?.[name]) as
				{ prototype: Record<string, unknown> } | undefined
	)
	.filter((ctor): ctor is { prototype: Record<string, unknown> } => typeof ctor?.prototype === 'object')
	.map((ctor) => ctor.prototype);
if (rungPrototypes.length === 0) {
	throw new Error(
		'tests/setup/svelte-dom-preload.ts: no Element/HTMLElement global to harden, so the mount rung ' +
			'would report fabricated zero geometry. A DOM must be installed before this point.'
	);
}

function unmeasurable(api: string): never {
	throw new Error(
		`${api} cannot measure on the MOUNT rung: happy-dom has no layout engine and fabricates a zero ` +
			`(node_modules/happy-dom/lib/nodes/element/Element.js,.../html-element/HTMLElement.js). Box ` +
			`geometry, clipping, env() and dvh/vh are decidable only on the LAYOUT rung — drive a real ` +
			`render through tests/e2e/driver.mjs (see tests/e2e/HARNESS.md and ` +
			`the layout rung). Do not read a zero here as a measurement.`
	);
}

for (const proto of rungPrototypes) {
	for (const method of ['getBoundingClientRect', 'getClientRects'] as const) {
		proto[method] = (): never => unmeasurable(`${method}`);
	}
	for (const prop of [
		'offsetWidth',
		'offsetHeight',
		'clientWidth',
		'clientHeight',
		'scrollWidth',
		'scrollHeight'
	] as const) {
		Object.defineProperty(proto, prop, {
			configurable: true,
			get: (): never => unmeasurable(prop)
		});
	}
}

// 3. SvelteKit virtual modules — the one place a `$app/*` or `$env/*` specifier is mapped. `build.module()` is the
// mechanism, NOT `onResolve`, which is never consulted for these specifiers. Each stub is re-exported from a real file
// under tests/setup/kit/ rather than inline, so a test driving the stub shares ONE module instance with the component.
const KIT_STUBS: Record<string, string> = {
	'$app/navigation': 'app-navigation.ts',
	'$app/state': 'app-state.ts',
	'$app/environment': 'app-environment.ts',
	'$env/dynamic/public': 'env-dynamic-public.ts'
};

// Nothing imports these today; registered so the first component to import one fails with a message naming the fix
// rather than bun's bare "Cannot find module", which reads as a broken component.
const KIT_UNSTUBBED = [
	'$app/forms',
	'$app/paths',
	'$app/server',
	'$app/stores',
	'$env/static/public',
	'$env/dynamic/private',
	'$env/static/private'
];

plugin({
	name: 'sveltekit-virtual-modules',
	setup(build) {
		for (const [specifier, file] of Object.entries(KIT_STUBS)) {
			// Plain interpolation rather than node:path — one fewer import in a file the whole suite preloads, and bun
			// accepts forward slashes on every platform it runs on.
			const stub = `${import.meta.dir}/kit/${file}`;
			build.module(specifier, () => ({
				contents: `export * from ${JSON.stringify(stub)};`,
				loader: 'ts'
			}));
		}
		for (const specifier of KIT_UNSTUBBED) {
			build.module(specifier, () => ({
				contents: `throw new Error(${JSON.stringify(
					`No test stub for SvelteKit virtual module '${specifier}'. Add one under tests/setup/kit/ ` +
						`and register it in KIT_STUBS in tests/setup/svelte-dom-preload.ts. Stubbed today: ` +
						`${Object.keys(KIT_STUBS).join(', ')}.`
				)});`,
				loader: 'ts'
			}));
		}
	}
});

// 3b. The bare `svelte` specifier, for DEPENDENCIES. Bits UI imports `getContext`/`setContext` from it, which under
// `bun test` resolves to Svelte's SERVER build, whose context stack is not the one a client `mount()` populates:
// `lifecycle_outside_component` the moment such a component mounts. A dependency's imports DO go through the plugin,
// unlike the test entry's own.
//
// Scoped to the EXACT specifier, so `svelte/internal/client`, `svelte/compiler` and `svelte/server` are untouched.
// Existence is CHECKED because this bypasses svelte's export map.
const SVELTE_CLIENT_ENTRY = join(
	dirname(createRequire(import.meta.url).resolve('svelte/package.json')),
	'src/index-client.js'
);
if (!existsSync(SVELTE_CLIENT_ENTRY)) {
	throw new Error(
		`test-setup: svelte's client entry is missing at ${SVELTE_CLIENT_ENTRY}.\n` +
			"This preload redirects the bare `svelte` specifier there so a dependency's `import { getContext }\n" +
			"from 'svelte'` resolves to the CLIENT build rather than the server one — without it no Bits UI\n" +
			'component can mount. If svelte no longer ships src/, point this at the exported client entry.'
	);
}
plugin({
	name: 'svelte-bare-specifier-is-client',
	setup(build) {
		build.module('svelte', () => ({
			contents: `export * from ${JSON.stringify(SVELTE_CLIENT_ENTRY)};`,
			loader: 'js'
		}));
	}
});

// 3c. `runed`, for svelte-sonner: a declared dependency present in the store, but resolution from inside bun's ISOLATED
// store fails at test time — and the home route imports the Toaster, so without this alias the mount rung cannot load
// `routes/+page.svelte` at all.
//
// RESOLVED FROM SVELTE-SONNER'S OWN PEER DIRECTORY, never by scanning the store for the greatest version: `bun.lock`
// carries THREE distinct runed resolutions and `build.module` is keyed on the SPECIFIER, so all three collapse onto
// whichever file this picks, and under 0.x every minor is breaking. Bun's sibling link matches the lockfile.
const RUNED_ENTRY = (() => {
	let ssPkg: string;
	try {
		ssPkg = createRequire(REPO_ROOT + '/').resolve('svelte-sonner/package.json');
	} catch {
		return null;
	}
	// <store>/svelte-sonner@X/node_modules/svelte-sonner/package.json -> …/node_modules/runed
	const peerDir = join(dirname(dirname(ssPkg)), 'runed');
	for (const entry of [join(peerDir, 'dist', 'index.js'), join(peerDir, 'dist', 'index.svelte.js')]) {
		if (existsSync(entry)) return entry;
	}
	return null;
})();
if (!RUNED_ENTRY) {
	// A throw, not a silent skip, which would leave the plugin unregistered and the home route's mount test dying on
	// bun's bare `Cannot find package`. Reachable via `--linker=hoisted`, a differently-rooted cache, or a store rename.
	throw new Error(
		"test-setup: could not resolve `runed` from svelte-sonner's own dependency directory.\n" +
			'svelte-sonner imports the bare specifier `runed`, and bun cannot resolve it out of its isolated\n' +
			'store at test time, so this preload aliases it. Without the alias no Bits UI component mounts and\n' +
			'the mount rung cannot load routes/+page.svelte at all.\n' +
			'Run `bun install --frozen-lockfile` from the repo root. If you installed with --linker=hoisted,\n' +
			'the sibling link this reads does not exist and the resolution needs revisiting.'
	);
}
{
	plugin({
		name: 'runed-bare-specifier',
		setup(build) {
			build.module('runed', () => ({
				contents: `export * from ${JSON.stringify(RUNED_ENTRY)};`,
				loader: 'js'
			}));
		}
	});
}

// 4. Svelte loader
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
