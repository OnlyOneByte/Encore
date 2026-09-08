// Re-exports Svelte's CLIENT runtime for component tests (issue #698).
//
// WHY THIS EXISTS. The bare `svelte` specifier resolves to Svelte's SERVER build under `bun test`
// (the `default` export condition), whose `mount()` throws "not available on the server". A preload
// plugin's `onResolve` does not intercept the test ENTRY file's own bare imports, so tests import
// mount/unmount/flushSync from HERE, and the runtime is taken from Svelte's client entry.
//
// The client entry is loaded with `createRequire` rather than a static `import`, deliberately: a
// static deep-path import of `src/index-client.js` has no declaration file, so `svelte-check` reports
// it as an implicit `any` (a typecheck error). Loading it at runtime and typing the handles against
// `svelte`'s own public signatures gives `bun test` the client functions AND `svelte-check` real
// types, with nothing to resolve statically.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { mount as MountFn, unmount as UnmountFn, flushSync as FlushFn, tick as TickFn } from 'svelte';

const require_ = createRequire(import.meta.url);
const clientPath = join(dirname(require_.resolve('svelte/package.json')), 'src/index-client.js');
const client = require_(clientPath) as {
	mount: typeof MountFn;
	unmount: typeof UnmountFn;
	flushSync: typeof FlushFn;
	tick: typeof TickFn;
};

export const mount = client.mount;
export const unmount = client.unmount;
export const flushSync = client.flushSync;
export const tick = client.tick;
