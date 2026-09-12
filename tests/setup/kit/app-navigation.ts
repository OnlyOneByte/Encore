// Test stub for SvelteKit's `$app/navigation` virtual module (rung M).
//
// SvelteKit synthesises `$app/*` at build time, so under `bun test` the specifier resolves to
// nothing and a component that imports it fails to load before any effect runs. The preload
// (tests/setup/svelte-dom-preload.ts) resolves `$app/navigation` to THIS file.
//
// It is a real on-disk module, not an inline remap, for the reason recorded in svelte-client.ts: a
// preload plugin's `onResolve` does not intercept the test ENTRY file's own bare imports, so a test
// that wants to assert on navigation imports `tests/setup/kit/app-navigation` directly while the
// component's own `$app/navigation` import is rewritten to the same module. Both paths therefore see
// one shared `calls` log.
//
// Every function RECORDS rather than navigates: there is no router under the harness, and a silent
// no-op would make "the button navigated" indistinguishable from "the button did nothing".

/** One recorded navigation call. `args` is the call's arguments, unmodified. */
export type NavigationCall = { fn: 'goto' | 'replaceState' | 'invalidateAll'; args: unknown[] };

/** Every navigation call since the last `resetNavigation()`, in order. */
export const calls: NavigationCall[] = [];

/** Clear the call log. Call this in a `beforeEach` so one test cannot read another's navigations. */
export function resetNavigation(): void {
	calls.length = 0;
}

export function goto(url: string | URL, opts?: unknown): Promise<void> {
	calls.push({ fn: 'goto', args: [url, opts] });
	return Promise.resolve();
}

export function replaceState(url: string | URL, state: unknown): void {
	calls.push({ fn: 'replaceState', args: [url, state] });
}

export function invalidateAll(): Promise<void> {
	calls.push({ fn: 'invalidateAll', args: [] });
	return Promise.resolve();
}
