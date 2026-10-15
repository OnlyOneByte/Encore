import { expect, test } from 'bun:test';
import { RoomLink } from '$lib/stores/room';

/*
 * "MAKE KARAOKE", AS THE LINK NOW OWNS IT. `requestProcess` was an inline `processMedia` on the Sing tab and the
 * only client caller of /api/process; the retry on a STALLED queue card is the second caller, and what it needed was
 * not the fetch but the three rules around it — the optimistic mark, what a refusal rolls back, and who is told.
 *
 * THE RULE THIS FILE EXISTS FOR IS THE SECOND ONE. A refused process must roll back the STATUS MARK and NOTHING
 * ELSE: the queue add rides the offline-tolerant `QueueStore` and is resent on resync, so rolling the turn back on a
 * transient refusal would delete a turn the guest genuinely asked for. That is also precisely how a dead turn is
 * made — the queue half lands, the process half does not — so this is the seam the stalled card is downstream of.
 *
 * `RoomLink` is exported beside the singleton so a test can build an isolated one, and `requestProcess` touches only
 * `fetch` and the `onError` channel — no socket, no window — so these are the real code paths.
 */

/** A url-taking stub as a `fetch`. Through `unknown` deliberately: `typeof fetch` carries static members
 *  (`preconnect`) that a plain function does not, and this path calls none of them. */
const asFetch = (impl: (url: string) => Promise<Response>): typeof fetch => impl as unknown as typeof fetch;

const jsonRes = (body: unknown, status: number) =>
	Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

/** Swap `fetch` for one call, record which urls were asked for and whatever reached the error channel. */
async function ask(
	impl: (url: string) => Promise<Response>,
	mediaId = 'm1'
): Promise<{ link: RoomLink; said: string[]; urls: string[] }> {
	const real = globalThis.fetch;
	const urls: string[] = [];
	globalThis.fetch = asFetch((url) => {
		urls.push(String(url));
		return impl(String(url));
	});
	const link = new RoomLink();
	const said: string[] = [];
	const stop = link.onError((m) => said.push(m));
	try {
		await link.requestProcess(mediaId);
		return { link, said, urls };
	} finally {
		stop();
		globalThis.fetch = real;
	}
}

test('the optimistic mark is set BEFORE the request is awaited', async () => {
	/* The ordering is load-bearing on both surfaces that call this. On the Sing tab the tapped row must read as
	   processing in the same tick as the tap rather than after a round trip; on /queue it is what keeps the card off
	   `queueCardKind`'s stalled arm during the window before the first broadcast — which is the whole reason the
	   tapping phone sees no stalled flash. Asserted by NOT awaiting: the mark has to be there already. */
	const real = globalThis.fetch;
	globalThis.fetch = asFetch(() => new Promise(() => {})); // never settles
	const link = new RoomLink();
	try {
		void link.requestProcess('m1');
		expect(link.mediaStatus.get('m1')).toEqual({ status: 'queued', pct: 0 });
	} finally {
		globalThis.fetch = real;
	}
});

test("a refusal rolls the MARK back and says the server's own words", async () => {
	// The cap refusal shape: /api/process answers 409 with a sentence phrased for a phone to print.
	const { link, said } = await ask(() => jsonRes({ error: 'You already have 2 songs processing.' }, 409));
	expect(link.mediaStatus.has('m1')).toBe(false);
	expect(said).toEqual(['You already have 2 songs processing.']);
});

test('a refusal rolls back NOTHING ELSE — the turn is not the mark', async () => {
	/* THE DEAD TURN IS MADE HERE, and it must stay made rather than be "cleaned up". The turn lives in the
	   `QueueStore` and is resent on resync, so a transient refusal that deleted it would destroy a turn the guest
	   asked for. Nothing on the link's queue side may move: `entries` and `pendingKind` are the two fields a
	   surface renders the rotation from. */
	const before = new RoomLink();
	const { link } = await ask(() => jsonRes({ error: 'nope' }, 500));
	expect(link.entries).toEqual(before.entries);
	expect([...link.pendingKind]).toEqual([...before.pendingKind]);
	expect(link.queue).toBe(before.queue); // undefined either way: no socket, so no store was built
});

test('a dropped request is a refusal too, with the generic sentence', async () => {
	// A thrown fetch (phone off the LAN mid-tap) reaches the same rollback: the status map must not keep a mark
	// for a request that never arrived, or the row cooks forever with nothing behind it.
	const { link, said } = await ask(() => Promise.reject(new TypeError('Failed to fetch')));
	expect(link.mediaStatus.has('m1')).toBe(false);
	expect(said).toEqual(["Couldn't start that."]);
});

test('an accepted request KEEPS the mark and says nothing', async () => {
	// The mark is what the row draws its bar from until the first `media:status` arrives, so clearing it on success
	// would blink the card back through the stalled arm — the exact flash the before-the-await ordering prevents.
	const { link, said, urls } = await ask(() => jsonRes({ ok: true }, 200));
	expect(link.mediaStatus.get('m1')).toEqual({ status: 'queued', pct: 0 });
	expect(said).toEqual([]);
	expect(urls).toEqual(['/api/process']);
});

test('stems already on disk re-reads the library, so the row goes ready without a worker', async () => {
	/* `alreadyReady` is the "processed on an earlier night" answer: there is no job to broadcast progress for, so
	   without the re-read the row would sit on its optimistic `queued` mark until something else refreshed. */
	const { urls } = await ask((url) =>
		url === '/api/process' ? jsonRes({ alreadyReady: true }, 200) : jsonRes({ library: [], tags: {} }, 200)
	);
	expect(urls).toContain('/api/library');
});
