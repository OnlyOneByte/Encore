// Test stub for SvelteKit's `$app/navigation` virtual module (mount rung), resolved by
// tests/setup/svelte-dom-preload.ts.
//
// A real on-disk module rather than an inline remap, so a test asserting on navigation and the component
// under test share ONE `calls` log. Every function RECORDS rather than navigates: there is no router
// here, and a silent no-op makes "the button navigated" indistinguishable from "it did nothing".

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
