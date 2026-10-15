import { expect, test } from 'bun:test';
import { RoomLink } from '$lib/stores/room';
import type { Media } from '$lib/contract';

/*
 * A DROPPED /api/library REQUEST IS NOT AN EMPTY LIBRARY, and this is the behavioural half of that fix.
 *
 * `refreshLibrary()` used to conflate the two on three counts: the fetch was nested
 * (`await (await fetch(…)).json()`) so the status was never checkable, the `catch` left no state behind, and
 * `finally` set `libraryLoaded = true` regardless. `library: []` + `libraryLoaded: true` is exactly the tuple
 * /library's `{:else if library.length === 0}` arm reads as "No karaoke tracks yet" — measured in a browser
 * over a 135-song library, with every control on the page gone and the dock simultaneously playing a track
 * FROM that library. Nothing re-asked: `connect()` is guarded idempotent and a tab tap is a client-side nav,
 * so the false empty survived any number of round trips and needed a full reload to clear.
 *
 * The class is exported beside the singleton precisely so a test can build an isolated one (see room.ts's
 * closing note), and `refreshLibrary()` touches only `fetch` — no socket, no window — so these are the real
 * code paths, not a re-statement of them.
 */

/** A `Media` with only the fields the library path actually carries through. */
const song = (id: string): Media =>
	({ id, source: 'youtube', sourceRef: id, title: `song ${id}`, durationSec: 100 }) as Media;

/** A zero-argument stub as a `fetch`. Through `unknown` deliberately: `typeof fetch` carries static members
 *  (`preconnect`) that a plain function does not, and `refreshLibrary` calls none of them. */
const asFetch = (impl: () => Promise<Response>): typeof fetch => impl as unknown as typeof fetch;

/** Swap `fetch` for the duration of one call and always put the real one back. */
async function withFetch(impl: () => Promise<Response>, run: (link: RoomLink) => Promise<void>) {
	const real = globalThis.fetch;
	globalThis.fetch = asFetch(impl);
	try {
		await run(new RoomLink());
	} finally {
		globalThis.fetch = real;
	}
}

const ok = (body: unknown) =>
	Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

test('a transport failure leaves libraryFailed set, not an empty library', async () => {
	await withFetch(
		() => Promise.reject(new TypeError('Failed to fetch')),
		async (link) => {
			await link.refreshLibrary();
			// Both halves. `libraryLoaded` must still resolve — left false the page spins forever — but the surface
			// now has a second bit to tell "we could not ask" from "you own nothing".
			expect(link.libraryLoaded).toBe(true);
			expect(link.libraryFailed).toBe(true);
			expect(link.library).toEqual([]);
		}
	);
});

test('a non-2xx with a parseable body fails too — the status is checked, not just the JSON', async () => {
	// THE CASE THE NESTED FETCH COULD NOT SEE. A 503 whose body parses to `{}` yielded `snapshot.library ?? []`,
	// i.e. a successful read of an empty library, which is the worst possible reading of a broken server.
	await withFetch(
		() => Promise.resolve(new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })),
		async (link) => {
			await link.refreshLibrary();
			expect(link.libraryFailed).toBe(true);
			expect(link.libraryLoaded).toBe(true);
		}
	);
});

test('a success clears the flag and seeds the catalog', async () => {
	await withFetch(
		() => ok({ library: [song('a'), song('b')], tags: { a: ['duet'] } }),
		async (link) => {
			link.libraryFailed = true; // as a previous failed attempt would have left it
			await link.refreshLibrary();
			expect(link.libraryFailed).toBe(false);
			expect(link.library.map((m) => m.id)).toEqual(['a', 'b']);
			expect(link.libraryTags).toEqual({ a: ['duet'] });
			// The fetch's second job: the queue's titles come from the catalog on a cold load.
			expect(link.mediaCatalog.get('a')?.title).toBe('song a');
		}
	);
});

test('a FAILED refresh keeps the rows it already had — the error state is additive', async () => {
	/* Why /library gates its failure arm on `library.length === 0` as well as the flag: `refreshLibrary()` also
	   runs on every `media:status` ready event, so one of those failing mid-party must not replace a working
	   shelf with an apology. The store's part of that contract is to leave `library` alone on the way out. */
	const real = globalThis.fetch;
	const link = new RoomLink();
	try {
		globalThis.fetch = asFetch(() => ok({ library: [song('a')] }));
		await link.refreshLibrary();
		globalThis.fetch = asFetch(() => Promise.reject(new TypeError('Failed to fetch')));
		await link.refreshLibrary();
	} finally {
		globalThis.fetch = real;
	}
	expect(link.libraryFailed).toBe(true);
	expect(link.library.map((m) => m.id)).toEqual(['a']);
});

test('the flag resets where the next attempt BEGINS, so a retry is not read against the last failure', async () => {
	const real = globalThis.fetch;
	const link = new RoomLink();
	/* The observable consequence of clearing at the top of the `try` rather than only on success: a subscriber
	   notified DURING the in-flight retry must not still see the previous failure, or /library would paint its
	   error arm over a request that is about to succeed. */
	let failedDuringFlight: boolean | undefined;
	try {
		globalThis.fetch = asFetch(() => Promise.reject(new TypeError('Failed to fetch')));
		await link.refreshLibrary();
		expect(link.libraryFailed).toBe(true);
		globalThis.fetch = asFetch(() => {
			failedDuringFlight = link.libraryFailed;
			return ok({ library: [song('a')] });
		});
		await link.refreshLibrary();
	} finally {
		globalThis.fetch = real;
	}
	expect(failedDuringFlight).toBe(false);
	expect(link.libraryFailed).toBe(false);
});
