// guard: the MOUNT-RUNG harness contract (#822) — `docs/ux/04-verification.md` XR-VER-01 and XR-VER-03.
//
// TWO THINGS ARE PINNED HERE, and they pull in opposite directions on purpose.
//
// 1. XR-VER-01 (rung M exists). SvelteKit synthesises `$app/*` and `$env/*` at build time, so under
//    `bun test` those specifiers resolved to nothing and EVERY route component failed to load before
//    a single effect ran — only leaves with zero `$app` imports (TvPlayer.svelte) could mount. The
//    preload now maps them to real stub modules under `test-setup/kit/`, so a route component can be
//    imported, mounted, and driven. Test 1 covers every import site by SCANNING for them rather than
//    hand-listing; tests 2a-2d pin each stub's own contract; test 3 drives the whole chain on the one
//    route that imports both modules — a stubbed `page.url` reaches the component's `$derived`, and
//    its `goto` lands in the stub's log.
//
// 2. XR-VER-03 (a geometry API that cannot measure fails loudly). happy-dom has no layout engine:
//    `getBoundingClientRect()` returns an all-zero `DOMRect` and `getClientRects()` puts that same
//    rect in a list. Zero is not a measurement, and the two natural guard shapes both go wrong with
//    it — `expect(w).toBeGreaterThan(0)` is a permanent red nobody trusts, and
//    `if (w > 0) expect(w).toBeGreaterThanOrEqual(44)` is a permanent SILENT GREEN. So the harness
//    throws instead, naming the rung and where the measurement can actually be taken (rung L,
//    `apps/core/e2e/cdp.mjs`). Test 5 pins that, and test 6 pins the same discipline for the no-op
//    `ResizeObserver` that `bind:clientHeight` needs, which is deliberately NOT installed.
//
// The tension is the point: making zeros loud is what keeps a component that MEASURES off this rung,
// which is why XR-VER-01's five-mount clause cannot be satisfied for a measuring component here and
// XR-VER-02 sends every measured claim to rung L.
//
// EVERY STUB IS IMPORTED LAZILY, INSIDE the test that needs it, and BY ITS `$app`/`$env` SPECIFIER —
// never at module scope. Two reasons, both load-bearing: importing by specifier is what proves the
// preload's mapping (a direct relative import would pass with the mapping deleted), and keeping the
// imports inside the tests means deleting one stub file reds the tests that use THAT stub by name
// instead of failing this whole file to load, which would leave the deletion pinned by nothing.
import { test, expect, beforeEach } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mount, unmount, flushSync } from '../../../../test-setup/svelte-client';

// import.meta.dir === apps/core/src/lib.
const SRC = join(import.meta.dir, '..');
const PRELOAD = join(import.meta.dir, '..', '..', '..', '..', 'test-setup', 'svelte-dom-preload.ts');

/** Every `.ts`/`.svelte` file under apps/core/src, excluding SvelteKit's generated tree. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		if (ent.name === '.svelte-kit' || ent.name === 'node_modules' || ent.name === 'build') continue;
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...sourceFiles(p));
		else if (ent.name.endsWith('.svelte') || ent.name.endsWith('.ts')) out.push(p);
	}
	return out;
}

const KIT_IMPORT = /import\s[^;]*?from\s*['"](\$(?:app|env)\/[^'"]+)['"]/g;

// Each stub is loaded BY SPECIFIER (the runtime assertion) but TYPED from the stub file (the compile
// assertion). TypeScript resolves `$app/*` to SvelteKit's own generated types, which know nothing of
// the test-only helpers (`setPage`, `calls`, …), so the cast is what lets one import prove the mapping
// and still be typechecked against what the stub actually exports. `typeof import(...)` is a type-only
// reference — it adds no second runtime import, so there is still exactly one module instance shared
// with the component under test.
type NavStub = typeof import('../../../../test-setup/kit/app-navigation');
type StateStub = typeof import('../../../../test-setup/kit/app-state');
type EnvironmentStub = typeof import('../../../../test-setup/kit/app-environment');
type PublicEnvStub = typeof import('../../../../test-setup/kit/env-dynamic-public');

const navStub = async (): Promise<NavStub> => (await import('$app/navigation')) as unknown as NavStub;
const stateStub = async (): Promise<StateStub> => (await import('$app/state')) as unknown as StateStub;
const environmentStub = async (): Promise<EnvironmentStub> =>
	(await import('$app/environment')) as unknown as EnvironmentStub;
const publicEnvStub = async (): Promise<PublicEnvStub> =>
	(await import('$env/dynamic/public')) as unknown as PublicEnvStub;

beforeEach(async () => {
	// `page` and the navigation log are module state shared with the component under test, so a URL or
	// a recorded call left behind would leak into the next test.
	(await stateStub()).resetPage();
	(await navStub()).resetNavigation();
});

// ── 1. Every `$app`/`$env` import site loads ──────────────────────────────────────────────────
// Derived from the tree, not hand-listed, so a component that starts importing a virtual module is
// covered the moment it lands. Carries a non-vacuity floor (XR-VER-05): a walk that finds nothing
// must fail rather than pass with zero files examined.
test('every component importing a $app/$env virtual module loads under the mount rung (#822)', async () => {
	const importers: { file: string; specifiers: string[] }[] = [];
	for (const file of sourceFiles(SRC)) {
		const specifiers = [...readFileSync(file, 'utf8').matchAll(KIT_IMPORT)].map((m) => m[1]!);
		if (specifiers.length > 0) importers.push({ file, specifiers });
	}
	// Floor: importers across the route/component tree. Re-anchored 5 -> 4 (sites 6 -> 5) by #834:
	// `/join` was retired (its `$app/navigation` + `$app/state` importer went with it) and its join UI
	// moved to JoinLanding.svelte (still both specifiers); at the same time `routes/+page.svelte` dropped
	// its `goto('/join')` bounce, so it no longer imports `$app/navigation` at all. Net one fewer
	// importer. Still non-vacuous — a broken walk enumerates zero and reds here.
	expect(importers.length, 'no $app/$env importer found — the walk is broken, not the tree').toBeGreaterThanOrEqual(4);
	const sites = importers.reduce((n, i) => n + i.specifiers.length, 0);
	expect(sites).toBeGreaterThanOrEqual(5);

	for (const { file } of importers) {
		// A bare `import()` of the component is the whole assertion: before the preload aliased these
		// specifiers this threw `Cannot find module '$app/navigation'` for every one of them.
		const mod = (await import(file)) as { default: unknown };
		expect(typeof mod.default, `${file} did not load a component`).toBe('function');
	}
	/*
	 * #913 S3: 20s, up from bun's 5s default. This test imports EVERY component that touches a
	 * SvelteKit virtual module, and the settings route now pulls in Bits UI — whose `.svelte` sources
	 * are compiled on demand by the preload's loader. Warm, the whole set loads in ~2.5s; a cold
	 * compile of that graph crossed 5s and timed out. The budget is for compile variance in a
	 * dependency, not for the app getting slower, so it is stated once here rather than raised globally.
	 */
}, 20_000);

// ── 2. Each stub module's own contract ────────────────────────────────────────────────────────
// One test per stub, so a deleted or hollowed-out stub is named by the failure rather than lumped in
// with its neighbours. Each asserts the SHAPE the app actually consumes, not merely that the import
// resolved — a stub that resolves to an empty module would still break every consumer.

test('$app/navigation is stubbed and records navigations instead of swallowing them (#822)', async () => {
	const nav = await navStub();
	expect(typeof nav.goto).toBe('function');
	expect(typeof nav.replaceState).toBe('function');
	expect(typeof nav.invalidateAll).toBe('function');
	await nav.goto('/somewhere');
	nav.replaceState('?tab=audio', {});
	await nav.invalidateAll();
	expect(nav.calls.map((c) => c.fn)).toEqual(['goto', 'replaceState', 'invalidateAll']);
	expect(nav.calls[0]!.args[0]).toBe('/somewhere');
});

test('$app/state is stubbed with a real URL and params, settable per test (#822)', async () => {
	const state = await stateStub();
	expect(state.page.url).toBeInstanceOf(URL);
	state.setPage({ url: '/join?room=ABCD', params: { mediaId: 'm-7' } });
	// The two first-party reads: `page.url.searchParams` (/join) and `page.params` (/metrics/[mediaId]).
	expect(state.page.url.searchParams.get('room')).toBe('ABCD');
	expect(state.page.params.mediaId).toBe('m-7');
	state.resetPage();
	expect(state.page.url.searchParams.get('room')).toBeNull();
});

test('$app/environment is stubbed with browser true, so client-only work runs (#822)', async () => {
	const env = await environmentStub();
	// `browser` must be TRUE: the harness installs a DOM and mounts with Svelte's CLIENT runtime, so a
	// component that guards its browser-only work on this flag has to run that work here or the mount
	// proves nothing about it.
	expect(env.browser).toBe(true);
	expect(env.building).toBe(false);
	expect(typeof env.version).toBe('string');
});

test('$env/dynamic/public is stubbed as a settable record (#822)', async () => {
	const pub = await publicEnvStub();
	expect(pub.env.PUBLIC_ANYTHING).toBeUndefined();
	pub.setEnv({ PUBLIC_ANYTHING: 'yes' });
	expect(pub.env.PUBLIC_ANYTHING).toBe('yes');
	pub.setEnv({});
	expect(pub.env.PUBLIC_ANYTHING).toBeUndefined();
});

test('an unstubbed SvelteKit virtual module fails with a message naming the stub directory (#822)', async () => {
	// `$app/forms` has no first-party importer, so this is the message the NEXT one gets — a missing
	// stub, not a broken component.
	await expect(import('$app/forms')).rejects.toThrow(/test-setup\/kit/);
});

// ── 3. A route component mounts, and both stubs are wired through it ──────────────────────────
test('the landing join surface mounts, reads the stubbed page.url, and its goto lands in the stub (#822)', async () => {
	const { setPage } = await stateStub();
	const { calls } = await navStub();
	// `/join` was retired (#834 Q2-A); its join UI is the JoinLanding component rendered in the
	// unjoined branch of `/`. A bare landing (no `?room`) joins the active room, and `?next=` is read
	// here exactly as the old route read it — which is the `page.url` wiring this rung proves.
	setPage({ url: '/?next=/settings' });
	const bodies: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((_url: string, init?: { body?: string }) => {
		bodies.push(init?.body ?? '');
		return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
	}) as typeof fetch;

	const target = document.createElement('div');
	document.body.appendChild(target);
	const Join = (await import('../lib/components/JoinLanding.svelte')).default as never;
	const instance = mount(Join, { target });
	flushSync();

	try {
		// Effects ran and the component rendered — the mount half of XR-VER-01.
		// #913: the field is <Input>, whose appearance lives in the component, so `.name-input` is gone.
		// `data-slot` is shadcn's own contract for the rendered element and survives a re-vendor.
		const input = target.querySelector("input[data-slot='input']") as HTMLInputElement | null;
		expect(input, 'JoinLanding mounted but rendered no name field').not.toBeNull();

		// Drive the real action. `bind:value` listens for `input`; the submit handler reads
		// `page.url.searchParams` for `next` and then calls `goto`.
		// The Event constructor must come from the happy-dom window: bun defines its own global
		// `Event`, so the preload's `g[name] === undefined` copy leaves it in place, and happy-dom's
		// `dispatchEvent` rejects an event that is not an instance of ITS Event class.
		const DomEvent = (globalThis as unknown as { window: { Event: typeof Event } }).window.Event;
		input!.value = 'Maya';
		input!.dispatchEvent(new DomEvent('input', { bubbles: true }));
		flushSync();
		// #913 S1 moved `.submit`'s page layout to a `.submit-slot` wrapper and the button itself to
		// <Button>, whose element carries `data-slot="button"`. The class is no longer on the control.
		const submit = target.querySelector('.submit-slot button') as HTMLButtonElement | null;
		expect(submit, 'JoinLanding rendered no submit button').not.toBeNull();
		submit!.click();
		flushSync();
		await Promise.resolve();
		await Promise.resolve();

		// The join button reached fetch — the action wired through the mount, not just static markup.
		expect(bodies.length, 'the join button did not reach fetch').toBe(1);
		// A bare landing carries no room code, so the active room is joined (`code` omitted).
		expect(JSON.parse(bodies[0]!).code).toBeUndefined();
		// `$app/navigation`: the navigation is recorded rather than silently swallowed, and it carries
		// the destination the stubbed `next` param asked for — the `page.url` read this rung proves.
		expect(calls.map((c) => c.fn)).toContain('goto');
		expect(String(calls.find((c) => c.fn === 'goto')!.args[0])).toBe('/settings');
	} finally {
		await unmount(instance);
		globalThis.fetch = realFetch;
	}
});

// ── 4. XR-VER-01 clause 2: the capability boundary stays written down ─────────────────────────
test('the preload documents the mount rung and where measurement is decidable (#822, XR-VER-01)', () => {
	const src = readFileSync(PRELOAD, 'utf8');
	// Only the file's HEADER counts — the code below it names these things incidentally (the stub
	// table, the throw message), and a boundary that lives only inside an error string is not written
	// down for the reader deciding which rung a new guard belongs on.
	const header = src.slice(0, src.search(/^import /m));
	expect(header.length, 'the preload has no header comment').toBeGreaterThan(400);
	for (const needle of [
		'$app', // which virtual modules this rung supplies
		'$env',
		'NO LAYOUT ENGINE', // why measurement is undecidable here
		'XR-VER-03',
		'cdp.mjs', // where it IS decidable
		'docs/ux/04-verification.md' // the checked-in capability document
	]) {
		expect(header, `the preload header no longer names ${needle}`).toContain(needle);
	}
});

// ── 5. XR-VER-03: geometry that cannot measure throws instead of reporting zero ───────────────
// All SIX APIs XR-VER-03 enumerates, not just the two methods. The four offset/client accessors are
// defined on `HTMLElement.prototype`, which SHADOWS `Element.prototype`, so a patch applied only to
// Element would leave every one of them returning 0 on exactly the elements a test mounts — which is
// why this asserts on a real `<div>` rather than on a prototype descriptor.
const GEOMETRY_METHODS = ['getBoundingClientRect', 'getClientRects'] as const;
const GEOMETRY_PROPS = [
	'offsetWidth',
	'offsetHeight',
	'clientWidth',
	'clientHeight',
	'scrollWidth',
	'scrollHeight'
] as const;

test('all six geometry APIs fail loudly on the mount rung (#822, XR-VER-03)', () => {
	const el = document.createElement('div');
	document.body.appendChild(el);
	try {
		for (const method of GEOMETRY_METHODS) {
			// The message must name the rung and where the measurement IS decidable, so the reader of a
			// red suite knows the guard belongs on rung L rather than that the element is missing.
			expect(() => (el as unknown as Record<string, () => unknown>)[method]!()).toThrow(/MOUNT rung/);
			expect(() => (el as unknown as Record<string, () => unknown>)[method]!()).toThrow(/cdp\.mjs/);
		}
		for (const prop of GEOMETRY_PROPS) {
			// A property read, not a call — `el.offsetHeight` is the shape a guard actually writes.
			expect(() => (el as unknown as Record<string, unknown>)[prop], `${prop} did not throw`).toThrow(/MOUNT rung/);
			expect(() => (el as unknown as Record<string, unknown>)[prop]).toThrow(new RegExp(prop));
		}
		// And each must THROW rather than return anything a guard could read as a measurement — a zero
		// is what `if (h > 0) expect(h).toBeGreaterThanOrEqual(44)` silently swallows.
		for (const api of [...GEOMETRY_METHODS, ...GEOMETRY_PROPS]) {
			let returned: unknown = 'never assigned';
			try {
				const raw = (el as unknown as Record<string, unknown>)[api];
				returned = typeof raw === 'function' ? (raw as () => unknown).call(el) : raw;
			} catch {
				returned = 'threw';
			}
			expect(returned, `${api} returned a value — a zero is a silent green`).toBe('threw');
		}
	} finally {
		el.remove();
	}
});

// ── 6. The no-op ResizeObserver stays absent, and the patch is not coupled to the DOM install ─
test('ResizeObserver is not installed, so bind:clientHeight has no silent path to 0 (#822, XR-VER-03)', () => {
	// happy-dom ships a ResizeObserver whose `observe()` is `// TODO: Not implemented`, so a
	// `bind:clientHeight` would never fire and the bound value would sit at its initial value forever.
	// Copying it onto globalThis would turn a loud ReferenceError at mount into a measurement of
	// nothing, so the preload deliberately omits it. Belt and braces with test 5: the `clientHeight`
	// read itself now throws too, so neither door leads to a fabricated zero.
	expect((globalThis as Record<string, unknown>).ResizeObserver).toBeUndefined();
	const preload = readFileSync(PRELOAD, 'utf8');
	expect(preload.includes("'ResizeObserver'")).toBe(false);
	// The geometry patch must NOT sit inside the `if (typeof g.document === 'undefined')` DOM-install
	// branch: the aliasing plugin is unconditional, and hardening only when this preload happened to
	// install the DOM is an asymmetry that fails silently under any other DOM provider.
	const installBranch = preload.slice(
		preload.indexOf("if (typeof g.document === 'undefined') {"),
		preload.indexOf('// ── 1b.')
	);
	expect(installBranch.length, 'the DOM-install branch moved — re-anchor this guard').toBeGreaterThan(100);
	expect(installBranch, 'the geometry patch is back inside the DOM-install branch').not.toContain('defineProperty');
});

// ── 7. The retired blocker claim must not come back ───────────────────────────────────────────
test('no test still documents the $app/$env virtual modules as un-aliased (#822)', () => {
	// wake-lock.test.ts carried the blocker ("the harness does not alias the `$app`/`$env` virtual
	// modules, so importing the component fails outright"). It is false as of this change, and a
	// stale blocker is what kept a real mount off the table. Prose-accuracy guard, the shape
	// doc-pointer-accuracy.test.ts already uses.
	const stale = /does\s+not\s+alias\s+the[\s\S]{0,40}\$app/;
	const offenders: string[] = [];
	// Excludes ONLY itself, by path — this file quotes the retired claim in its own comment, which is
	// exactly the thing the guard looks for.
	const scanned = sourceFiles(SRC).filter((f) => f.endsWith('.test.ts') && f !== import.meta.path);
	for (const file of scanned) {
		if (stale.test(readFileSync(file, 'utf8'))) offenders.push(file);
	}
	// Floor (XR-VER-05): this suite has hundreds of test files; a walk finding a handful is broken.
	expect(scanned.length, 'the test-file walk is broken').toBeGreaterThan(50);
	expect(offenders, 'a test still claims the harness cannot alias $app/$env').toEqual([]);
});
