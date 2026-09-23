// guard: the MOUNT-RUNG harness contract. Two things are pinned here and they pull in opposite directions on
// purpose.
//
// 1. RUNG M EXISTS. SvelteKit synthesises `$app/*` and `$env/*` at build time, so under `bun test` those
//    specifiers resolved to nothing and EVERY route component failed to load before a single effect ran. The
//    preload maps them to real stub modules under `tests/setup/kit/`, so a route component can be imported,
//    mounted and driven. Test 1 covers every import site by SCANNING for them rather than hand-listing.
//
// 2. A GEOMETRY API THAT CANNOT MEASURE FAILS LOUDLY. happy-dom has no layout engine, so
//    `getBoundingClientRect()` returns an all-zero rect — and both natural guard shapes go wrong with it:
//    `expect(w).toBeGreaterThan(0)` is a permanent red nobody trusts, and `if (w > 0) expect(w) >= 44` is a
//    permanent SILENT GREEN. The harness throws instead, naming the rung and where the measurement can be
//    taken (rung L, `tests/e2e/driver.mjs`).
//
// The tension is the point: making zeros loud is what keeps a component that MEASURES off this rung and sends
// every measured claim to rung L.
//
// EVERY STUB IS IMPORTED LAZILY, inside the test that needs it, and BY ITS `$app`/`$env` SPECIFIER — never at
// module scope. Importing by specifier is what proves the preload's mapping (a relative import would pass with
// the mapping deleted), and keeping the imports inside the tests means deleting one stub reds the tests that
// use THAT stub by name instead of failing this whole file to load, which would leave the deletion pinned by
// nothing.
import { test, expect, beforeEach } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { mount, unmount, flushSync } from '$setup/svelte-client';
import { at, repoRoot, srcDir } from '@encore/test-support';

// Anchored from the repo root, never from where this test sits, so a move is a git mv.
const SRC = srcDir;

// The repo root, resolved once by @encore/test-support (it walks up for bunfig.toml).
const REPO_ROOT = repoRoot;
const PRELOAD = at('tests', 'setup', 'svelte-dom-preload.ts');

/** Every `.ts`/`.svelte` file under src, excluding SvelteKit's generated tree. */
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

// Each stub is loaded BY SPECIFIER (the runtime assertion) but TYPED from the stub file (the compile one).
// TypeScript resolves `$app/*` to SvelteKit's generated types, which know nothing of the test-only helpers, so
// the cast lets one import prove the mapping and still be typechecked. `typeof import(...)` is type-only, so
// there is still exactly one module instance shared with the component under test.
type NavStub = typeof import('$setup/kit/app-navigation');
type StateStub = typeof import('$setup/kit/app-state');
type EnvironmentStub = typeof import('$setup/kit/app-environment');
type PublicEnvStub = typeof import('$setup/kit/env-dynamic-public');

const navStub = async (): Promise<NavStub> => (await import('$app/navigation')) as unknown as NavStub;
const stateStub = async (): Promise<StateStub> => (await import('$app/state')) as unknown as StateStub;
const environmentStub = async (): Promise<EnvironmentStub> =>
	(await import('$app/environment')) as unknown as EnvironmentStub;
const publicEnvStub = async (): Promise<PublicEnvStub> =>
	(await import('$env/dynamic/public')) as unknown as PublicEnvStub;

beforeEach(async () => {
	// `page` and the navigation log are module state shared with the component under test.
	(await stateStub()).resetPage();
	(await navStub()).resetNavigation();
});

// 1. Every `$app`/`$env` import site loads — derived from the tree, not hand-listed, so a component that starts
// importing a virtual module is covered the moment it lands.
test('every component importing a $app/$env virtual module loads under the mount rung', async () => {
	const importers: { file: string; specifiers: string[] }[] = [];
	for (const file of sourceFiles(SRC)) {
		const specifiers = [...readFileSync(file, 'utf8').matchAll(KIT_IMPORT)].map((m) => m[1]!);
		if (specifiers.length > 0) importers.push({ file, specifiers });
	}
	// Floor: importers across the route/component tree. A broken walk enumerates zero and reds here rather than
	// passing with nothing examined.
	expect(importers.length, 'no $app/$env importer found — the walk is broken, not the tree').toBeGreaterThanOrEqual(4);
	const sites = importers.reduce((n, i) => n + i.specifiers.length, 0);
	expect(sites).toBeGreaterThanOrEqual(5);

	for (const { file } of importers) {
		// A bare `import()` is the whole assertion: before the preload aliased these, every one threw.
		const mod = (await import(file)) as Record<string, unknown>;

		if (file.endsWith('.svelte')) {
			// A component's default export IS the component — the strongest available check that the module not
			// only resolved but produced something mountable.
			expect(typeof mod.default, `${file} did not load a component`).toBe('function');
			continue;
		}

		/*
		 * A NON-COMPONENT importer (`routes/components/+page.server.ts` reads `dev` from `$app/environment`) has no
		 * default export and must not be asked for one. What is under test is that the virtual module RESOLVES, and
		 * asserting it exports something keeps this branch from degrading into `expect(true)`.
		 */
		expect(
			Object.keys(mod).length,
			`${file} imports a $app/$env module but exports nothing — it cannot be what resolved the alias`
		).toBeGreaterThan(0);
	}
}, 20_000);

// 2. Each stub module's own contract, one test per stub so a hollowed-out stub is named by the failure. Each
// asserts the SHAPE the app consumes, not merely that the import resolved.

test('$app/navigation is stubbed and records navigations instead of swallowing them', async () => {
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

test('$app/state is stubbed with a real URL and params, settable per test', async () => {
	const state = await stateStub();
	expect(state.page.url).toBeInstanceOf(URL);
	state.setPage({ url: '/join?room=ABCD', params: { mediaId: 'm-7' } });
	// The two first-party reads: `page.url.searchParams` (/join) and `page.params` (/metrics/[mediaId]).
	expect(state.page.url.searchParams.get('room')).toBe('ABCD');
	expect(state.page.params.mediaId).toBe('m-7');
	state.resetPage();
	expect(state.page.url.searchParams.get('room')).toBeNull();
});

test('$app/environment is stubbed with browser true, so client-only work runs', async () => {
	const env = await environmentStub();
	// `browser` must be TRUE: the harness installs a DOM and mounts with Svelte's CLIENT runtime, so a component
	// that guards browser-only work on this flag has to run it here or the mount proves nothing about it.
	expect(env.browser).toBe(true);
	expect(env.building).toBe(false);
	expect(typeof env.version).toBe('string');
});

test('$env/dynamic/public is stubbed as a settable record', async () => {
	const pub = await publicEnvStub();
	expect(pub.env.PUBLIC_ANYTHING).toBeUndefined();
	pub.setEnv({ PUBLIC_ANYTHING: 'yes' });
	expect(pub.env.PUBLIC_ANYTHING).toBe('yes');
	pub.setEnv({});
	expect(pub.env.PUBLIC_ANYTHING).toBeUndefined();
});

test('an unstubbed SvelteKit virtual module fails with a message naming the stub directory', async () => {
	// `$app/forms` has no first-party importer, so this is the message the NEXT one gets: a missing stub.
	await expect(import('$app/forms')).rejects.toThrow(/tests\/setup\/kit/);
});

// ── 3. A route component mounts, and both stubs are wired through it ──────────────────────────
test('the landing join surface mounts, reads the stubbed page.url, and its goto lands in the stub', async () => {
	const { setPage } = await stateStub();
	const { calls } = await navStub();
	/*
	 * `/join` was retired; its join UI is JoinLanding rendered in the unjoined branch of `/`, and `?next=` is read
	 * exactly as the old route read it — that `page.url` wiring is what this rung proves. The stub arrives WITH a
	 * room code deliberately: a code-less guest gets the CODE pane, which has no name field and whose Continue
	 * resolves a room rather than joining one, so driving it would prove the opposite of what this rung is for.
	 */
	setPage({ url: '/?room=K7MP2Q&next=/settings' });
	const bodies: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((url: string, init?: { body?: string }) => {
		// The preview GET carries no body; only the join POST is recorded, so `bodies` is a log of join attempts.
		if (String(url).includes('/api/room-preview')) {
			const preview = { code: 'K7MP2Q', presentCount: 2, names: ['Maya', 'Dana'] };
			return Promise.resolve(
				new Response(JSON.stringify(preview), { status: 200, headers: { 'content-type': 'application/json' } })
			);
		}
		bodies.push(init?.body ?? '');
		return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
	}) as typeof fetch;

	const target = document.createElement('div');
	document.body.appendChild(target);
	const Join = (await import('$lib/components/JoinLanding.svelte')).default as never;
	const instance = mount(Join, { target });
	flushSync();

	try {
		/*
		 * LET THE PREVIEW LAND FIRST. `/api/room-preview` is a fetch, so at the flushSync above the pane is still
		 * RESOLVING and carries no name field — querying without settling reported "mounted but rendered no name
		 * field", which reads as a broken component rather than a pending request. Two microtask turns is what the
		 * promise chain needs; the same idiom follows the submit click below.
		 */
		await Promise.resolve();
		await Promise.resolve();
		flushSync();

		const input = target.querySelector("input[data-slot='input']") as HTMLInputElement | null;
		expect(input, 'JoinLanding mounted but rendered no name field').not.toBeNull();

		// Drive the real action: `bind:value` listens for `input`, and the submit handler reads
		// `page.url.searchParams` for `next` before calling `goto`. The Event constructor must come from the
		// happy-dom window — bun defines its own global `Event`, and happy-dom's `dispatchEvent` rejects an event
		// that is not an instance of ITS Event class.
		const DomEvent = (globalThis as unknown as { window: { Event: typeof Event } }).window.Event;
		input!.value = 'Maya';
		input!.dispatchEvent(new DomEvent('input', { bubbles: true }));
		flushSync();
		// The button is a <Button> inside a `.submit-slot` wrapper; the class is no longer on the control itself.
		const submit = target.querySelector('.submit-slot button') as HTMLButtonElement | null;
		expect(submit, 'JoinLanding rendered no submit button').not.toBeNull();
		submit!.click();
		flushSync();
		await Promise.resolve();
		await Promise.resolve();

		// The join button reached fetch — the action wired through the mount, not just static markup.
		expect(bodies.length, 'the join button did not reach fetch').toBe(1);
		// The scanned code is what gets joined, and it is the code the preview CONFIRMED rather than whatever was
		// in the URL — the distinction `previewCode` exists for.
		expect(JSON.parse(bodies[0]!).code).toBe('K7MP2Q');
		// The navigation is recorded rather than swallowed, and carries the destination the stubbed `next` asked for.
		expect(calls.map((c) => c.fn)).toContain('goto');
		expect(String(calls.find((c) => c.fn === 'goto')!.args[0])).toBe('/settings');
	} finally {
		await unmount(instance);
		globalThis.fetch = realFetch;
	}
});

// 4. The capability boundary stays written down.
test('the preload documents the mount rung and where measurement is decidable', () => {
	const src = readFileSync(PRELOAD, 'utf8');
	// Only the file's HEADER counts: the code below names these things incidentally (the stub table, the throw
	// message), and a boundary living only inside an error string is not written down for the next reader.
	const header = src.slice(0, src.search(/^import /m));
	expect(header.length, 'the preload has no header comment').toBeGreaterThan(400);
	// RE-ANCHORED off an exact uppercase phrase: the needles are the things the boundary is ABOUT, not a
	// wording. `NO LAYOUT ENGINE` was one styling of the same sentence and a prose edit reworded it.
	for (const needle of [
		'$app', // which virtual modules this rung supplies
		'$env',
		'MOUNT rung', // which rung this is
		'LAYOUT rung', // where measurement is decidable instead
		'driver.mjs' // and what drives it
	]) {
		expect(header, `the preload header no longer names ${needle}`).toContain(needle);
	}
});

// 5. Geometry that cannot measure throws instead of reporting zero — all SIX APIs, not just the two methods.
// The four offset/client accessors are defined on `HTMLElement.prototype`, which SHADOWS `Element.prototype`,
// so a patch applied only to Element would leave every one returning 0 on exactly the elements a test mounts.
// Which is why this asserts on a real `<div>` rather than on a prototype descriptor.
const GEOMETRY_METHODS = ['getBoundingClientRect', 'getClientRects'] as const;
const GEOMETRY_PROPS = [
	'offsetWidth',
	'offsetHeight',
	'clientWidth',
	'clientHeight',
	'scrollWidth',
	'scrollHeight'
] as const;

test('all six geometry APIs fail loudly on the mount rung', () => {
	const el = document.createElement('div');
	document.body.appendChild(el);
	try {
		for (const method of GEOMETRY_METHODS) {
			// The message must name the rung AND where the measurement IS decidable, so the reader of a red knows
			// the guard belongs on rung L rather than that the element is missing.
			expect(() => (el as unknown as Record<string, () => unknown>)[method]!()).toThrow(/MOUNT rung/);
			expect(() => (el as unknown as Record<string, () => unknown>)[method]!()).toThrow(/driver\.mjs/);
		}
		for (const prop of GEOMETRY_PROPS) {
			// A property read, not a call — `el.offsetHeight` is the shape a guard actually writes.
			expect(() => (el as unknown as Record<string, unknown>)[prop], `${prop} did not throw`).toThrow(/MOUNT rung/);
			expect(() => (el as unknown as Record<string, unknown>)[prop]).toThrow(new RegExp(prop));
		}
		// And each must THROW rather than return anything a guard could read as a measurement.
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

// 6. The no-op ResizeObserver stays absent, and the patch is not coupled to the DOM install.
test('ResizeObserver is not installed, so bind:clientHeight has no silent path to 0', () => {
	// happy-dom ships a ResizeObserver whose `observe()` is not implemented, so a `bind:clientHeight` would never
	// fire and the bound value would sit at its initial value forever. Copying it onto globalThis would turn a
	// loud ReferenceError at mount into a measurement of nothing, so the preload omits it.
	expect((globalThis as Record<string, unknown>).ResizeObserver).toBeUndefined();
	const preload = readFileSync(PRELOAD, 'utf8');
	expect(preload.includes("'ResizeObserver'")).toBe(false);
	// The geometry patch must NOT sit inside the `if (typeof g.document === 'undefined')` DOM-install branch: the
	// aliasing plugin is unconditional, and hardening only when this preload happened to install the DOM is an
	// asymmetry that fails silently under any other DOM provider.
	//
	// The branch is BRACE-MATCHED rather than sliced to a comment heading. Anchoring the end of the slice on a
	// `1b.` banner made a prose edit in the preload extend it to the end of the file, so the arm reported the
	// patch back inside the branch when nothing had moved.
	const branchStart = preload.indexOf("if (typeof g.document === 'undefined') {");
	expect(branchStart, 'the DOM-install branch is gone — re-anchor this guard').toBeGreaterThan(-1);
	let depth = 0;
	let branchEnd = branchStart;
	for (let i = preload.indexOf('{', branchStart); i < preload.length; i += 1) {
		if (preload[i] === '{') depth += 1;
		else if (preload[i] === '}') {
			depth -= 1;
			if (depth === 0) {
				branchEnd = i + 1;
				break;
			}
		}
	}
	const installBranch = preload.slice(branchStart, branchEnd);
	expect(installBranch.length, 'the DOM-install branch moved — re-anchor this guard').toBeGreaterThan(100);
	expect(installBranch.endsWith('}'), 'the brace match did not close the branch').toBe(true);
	expect(installBranch, 'the geometry patch is back inside the DOM-install branch').not.toContain('defineProperty');
});

test('no test still documents the $app/$env virtual modules as un-aliased', () => {
	// A stale blocker is what kept a real mount off the table: wake-lock.test.ts carried "the harness does not
	// alias the `$app`/`$env` virtual modules", which is false. Prose-accuracy guard.
	const stale = /does\s+not\s+alias\s+the[\s\S]{0,40}\$app/;
	const offenders: string[] = [];
	/*
	 * EVERY test file in the repo, wherever it lives. A walk rooted at `SRC` alone would examine only what had not
	 * moved into `tests/` yet and keep passing while its coverage quietly halved — the silent-vacuity shape the
	 * rule refuses. Anchored on the repo root, so this arm does not care where a test lives.
	 */
	const roots = [SRC, join(REPO_ROOT, 'tests')].filter((d) => existsSync(d));
	// This file is excluded from its own stale-prose scan by BASENAME, not by its address: a split-argument
	// self-address (`at('tests','unit','core','lib',…)`) never appears as a greppable path, so flattening a
	// directory away silently invalidated it and the guard reported its own documentation as an offender.
	const SELF_NAME = 'mount-rung.test.ts';
	const scanned = roots
		.flatMap((d) => sourceFiles(d))
		.filter((f) => f.endsWith('.test.ts') && basename(f) !== SELF_NAME);
	for (const file of scanned) {
		if (stale.test(readFileSync(file, 'utf8'))) offenders.push(file);
	}
	// Floor: this suite has hundreds of test files, so a walk finding a handful is broken.
	expect(scanned.length, 'the test-file walk is broken').toBeGreaterThan(200); // @nvf-floor scanned.length
	expect(offenders, 'a test still claims the harness cannot alias $app/$env').toEqual([]);
});
