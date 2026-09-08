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
//
// Tests get the CLIENT `mount`/`unmount`/`flushSync` from `test-setup/svelte-client.ts` (the bare
// `svelte` specifier resolves to the SERVER build under `bun test`, whose `mount()` throws). A
// preload plugin's `onResolve` does NOT intercept the test entry file's own bare imports, so the
// client entry is re-exported from a real on-disk module instead of remapped here.
//
// Wired via the root `bunfig.toml` `[test] preload`, so it runs ONCE before the suite and forks
// nothing. Zero production change; no existing test imports a Svelte file, so nothing else changes.
import { plugin, Transpiler } from 'bun';
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

// ── 2. Svelte loader ──────────────────────────────────────────────────────────────────────────
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
