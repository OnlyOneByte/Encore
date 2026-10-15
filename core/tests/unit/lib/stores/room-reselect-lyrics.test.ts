import { expect, test } from 'bun:test';
import { RoomLink } from '$lib/stores/room';

/*
 * A RE-PICK THAT WAS REFUSED MUST BE DISTINGUISHABLE FROM ONE THAT LANDED, and `reselectLyrics` used to resolve
 * `Promise<void>` for both.
 *
 * Three things on /song/[mediaId] depend on telling them apart, and all three were broken by the one missing
 * return: nothing re-read the page's own write (so the peek described the state before the tap until a reload),
 * nothing released the local `justPicked` flag on a refusal (the server broadcasts no `media:status` for one, so
 * the control stayed `disabled` + `aria-busy` until the guest reloaded), and the pasted draft was discarded
 * whatever the server said. The server's own refusal wording already exists for this — `/api/lyrics-reselect`
 * answers 401/409/400 with sentences its comment says are phrased "so the phone can say why nothing happened".
 *
 * `RoomLink` is exported beside the singleton so a test can build an isolated one, and `reselectLyrics` touches
 * only `fetch` and the `onError` channel — no socket, no window — so these are the real code paths.
 */

/** A zero-argument stub as a `fetch`. Through `unknown` deliberately: `typeof fetch` carries static members
 *  (`preconnect`) that a plain function does not, and `reselectLyrics` calls none of them. */
const asFetch = (impl: () => Promise<Response>): typeof fetch => impl as unknown as typeof fetch;

const jsonRes = (body: unknown, status: number) =>
	Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

/** Swap `fetch` for one call, collect whatever reached the error channel, and always put the real one back. */
async function pick(
	impl: () => Promise<Response>,
	choice: { ref?: string; text?: string } = { ref: 'derived/lyrics/x.json' }
): Promise<{ ok: boolean; said: string[] }> {
	const real = globalThis.fetch;
	globalThis.fetch = asFetch(impl);
	const link = new RoomLink();
	const said: string[] = [];
	const stop = link.onError((m) => said.push(m));
	try {
		return { ok: await link.reselectLyrics('m1', choice), said };
	} finally {
		stop();
		globalThis.fetch = real;
	}
}

test('a 200 resolves true and says nothing', async () => {
	// The body the endpoint really returns on success, so the shape this reads is the shape it gets.
	const { ok, said } = await pick(() => jsonRes({ job: { id: 'j1' }, ref: 'derived/lyrics/m1-manual-word.json' }, 200));
	expect(ok).toBe(true);
	// A landed write is reported by the page re-reading itself, NOT by an error-channel message.
	expect(said).toEqual([]);
});

test("a 409 resolves false and forwards the server's own sentence", async () => {
	/* `not-processed` is the refusal a guest actually hits: the control renders off stored candidates, but the
	   re-time needs the vocals stem, so a song whose stems were reaped refuses every pick. This sentence is the
	   endpoint's, verbatim — the store must not re-word it. */
	const { ok, said } = await pick(() =>
		jsonRes({ error: 'that song is not processed yet — there is nothing to re-time', reason: 'not-processed' }, 409)
	);
	expect(ok).toBe(false);
	expect(said).toEqual(['that song is not processed yet — there is nothing to re-time']);
});

test('a refusal with no parseable body still resolves false, under the generic sentence', async () => {
	// A 401 from a context that never joined answers `not joined`, but an HTML error page or an empty body must
	// not leave the caller reading `undefined` as acceptance.
	const { ok, said } = await pick(() => Promise.resolve(new Response('<html>nope</html>', { status: 502 })));
	expect(ok).toBe(false);
	expect(said).toEqual(['Could not re-time the lyrics']);
});

test('a dropped request resolves false, under the connection sentence', async () => {
	const { ok, said } = await pick(() => Promise.reject(new TypeError('Failed to fetch')), { text: 'some words' });
	expect(ok).toBe(false);
	expect(said).toEqual(['Could not re-time the lyrics — check your connection']);
});

test('with nobody listening a refusal is still FALSE — the boolean is not the toast', async () => {
	/* The whole reason the boolean exists rather than only the message: the link's doc says an unhandled
	   message is dropped, and this page was the one route that produced these messages without registering a
	   handler. The release of the pending control must not depend on anyone having subscribed. */
	const real = globalThis.fetch;
	globalThis.fetch = asFetch(() => jsonRes({ error: 'that lyrics option is no longer available' }, 409));
	try {
		expect(await new RoomLink().reselectLyrics('m1', { ref: 'gone.json' })).toBe(false);
	} finally {
		globalThis.fetch = real;
	}
});
