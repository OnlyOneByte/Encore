// Test stub for SvelteKit's `$app/state` virtual module (issue #822, rung M).
//
// Two first-party consumers read `page` today: routes/join/+page.svelte (`page.url.searchParams`)
// and routes/metrics/[mediaId]/+page.svelte (`page.params.mediaId`). The stub therefore carries a
// real `URL` and a real params record, so a component reading either gets a value of the right
// shape rather than `undefined`.
//
// Mutated in place (never reassigned) so a component that captured the object at import time and a
// test that calls `setPage()` afterwards are looking at the same object.

/** The subset of SvelteKit's `page` the app reads, plus the fields a mount touches incidentally. */
export type StubPage = {
	url: URL;
	params: Record<string, string>;
	route: { id: string | null };
	status: number;
	error: Error | null;
	data: Record<string, unknown>;
	form: unknown;
};

export const page: StubPage = {
	url: new URL('http://localhost/'),
	params: {},
	route: { id: null },
	status: 200,
	error: null,
	data: {},
	form: null
};

/**
 * Point `page` at a URL and/or route params before mounting. `url` is resolved against
 * `http://localhost/`, so both `'/join?room=ABCD'` and a full URL work.
 */
export function setPage(next: { url?: string | URL; params?: Record<string, string> }): void {
	if (next.url !== undefined) page.url = new URL(next.url, 'http://localhost/');
	if (next.params !== undefined) page.params = next.params;
}

/** Restore the defaults. Call this in a `beforeEach` so one test cannot leak its URL into another. */
export function resetPage(): void {
	page.url = new URL('http://localhost/');
	page.params = {};
	page.route = { id: null };
	page.status = 200;
	page.error = null;
	page.data = {};
	page.form = null;
}
