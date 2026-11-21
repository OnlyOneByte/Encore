import { afterEach, expect, test } from 'bun:test';
import { RoomLink, UNREACHABLE_AFTER_MS, type RoomStatus } from '$lib/stores/room';

/*
 * "I WAS IN, I PUT MY PHONE DOWN, AND IT ASKED ME FOR THE ROOM CODE AGAIN." `connect()` read every failure of
 * `/api/me` as "not joined": a 502 from a restarting server settled a joined phone as a guest, and a network error
 * rejected `connect()` with the link stuck at `connecting`, so no later call ever asked again. Only a 401 means not
 * joined; everything else is asked again until it answers, and the status says so after UNREACHABLE_AFTER_MS.
 *
 * The link runs its REAL connect path against a real Bun WebSocket server, which also counts the sockets opened:
 * the retry must live inside the one `connect()`, never a second socket.
 */

const restore: (() => void)[] = [];
afterEach(() => {
	for (const fn of restore.splice(0).reverse()) fn();
});

function stub<K extends string>(key: K, value: unknown): void {
	const g = globalThis as Record<string, unknown>;
	const had = key in g;
	const old = g[key];
	g[key] = value;
	restore.push(() => (had ? (g[key] = old) : delete g[key]));
}

const JOINED = () => Response.json({ singer: { id: 's1', displayName: 'Maya', color: '#a78bfa' } });

/** A room whose `/api/me` answers from `answers` in turn (the last one repeating), with a socket server behind it. */
function room(answers: (() => Response | Promise<Response>)[]) {
	let sockets = 0;
	const server = Bun.serve({
		port: 0,
		fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no', { status: 404 })),
		websocket: {
			open: () => void sockets++,
			message() {}
		}
	});
	restore.push(() => server.stop(true));
	stub('window', new EventTarget());
	stub('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
	stub('location', { protocol: 'http:', host: `127.0.0.1:${server.port}` });
	let asked = 0;
	stub('fetch', (url: string | URL) => {
		if (!String(url).startsWith('/api/me')) return Promise.resolve(Response.json({ library: [] }));
		const answer = answers[Math.min(asked++, answers.length - 1)]!;
		return Promise.resolve().then(answer);
	});
	const link = new RoomLink();
	restore.push(() => link.close());
	const seen: RoomStatus[] = [link.status];
	link.subscribe(() => {
		if (seen.at(-1) !== link.status) seen.push(link.status);
	});
	return { link, seen, asked: () => asked, sockets: () => sockets };
}

const NETWORK_DOWN = () => Promise.reject(new TypeError('Failed to fetch'));

test('a 401 is the one answer that means not joined', async () => {
	const r = room([() => new Response('', { status: 401 })]);
	await r.link.connect();
	expect(r.link.status).toBe('not-joined');
	expect(r.link.me).toBeNull();
	expect(r.asked()).toBe(1);
	expect(r.sockets()).toBe(0);
});

test('a 502 is asked again, and the phone lands joined without ever being "not joined"', async () => {
	const r = room([() => new Response('bad gateway', { status: 502 }), JOINED]);
	const done = r.link.connect();
	await Bun.sleep(50); // the first answer is in and the retry is waiting
	expect(r.link.status).toBe('checking');
	await done;
	expect(r.link.status).toBe('joined');
	expect(r.link.me?.displayName).toBe('Maya');
	expect(r.seen).toEqual(['checking', 'joined']);
	expect(r.asked()).toBe(2);
});

test('a network that stays down past 3 s says unreachable, keeps asking, and joins on one socket', async () => {
	// Asks at 0, 0.25, 0.75, 1.75 and 2.75 s fail; the 6th, at 4.25 s, answers.
	const answers = [...Array(5).fill(NETWORK_DOWN), JOINED];
	const r = room(answers);
	const done = r.link.connect();
	// The owner's 3 s, written out: the constant is what is under test, so the test does not read it back.
	expect(UNREACHABLE_AFTER_MS).toBe(3000);
	await Bun.sleep(2800);
	expect(r.link.status, 'said unreachable before the owner’s 3 s').toBe('checking');
	await Bun.sleep(400);
	expect(r.link.status).toBe('unreachable');
	await done;
	expect(r.link.status).toBe('joined');
	expect(r.seen).toEqual(['checking', 'unreachable', 'joined']);
	expect(r.asked()).toBe(answers.length);
	// A later connect() — a remount, a tab tap — is still the no-op it always was.
	await r.link.connect();
	await Bun.sleep(100);
	expect(r.sockets()).toBe(1);
}, 10_000);

test('a blip that ends at 2.5 s is caught before the message, not after it', async () => {
	const t0 = Date.now();
	const r = room([() => (Date.now() - t0 < 2500 ? NETWORK_DOWN() : JOINED())]);
	await r.link.connect();
	expect(Date.now() - t0, 'joined only after the 3 s message would have shown').toBeLessThan(3000);
	expect(r.seen).toEqual(['checking', 'joined']);
}, 10_000);

test('an ask still in flight at 3 s gets to answer before the message shows', async () => {
	// The network is back at 2.6 s, but the round trip that finds out takes 600 ms and lands after the 3 s mark.
	const t0 = Date.now();
	const r = room([() => (Date.now() - t0 < 2600 ? NETWORK_DOWN() : Bun.sleep(600).then(JOINED))]);
	await r.link.connect();
	expect(Date.now() - t0).toBeGreaterThan(3000);
	expect(r.seen, 'the message flashed for one round trip').toEqual(['checking', 'joined']);
}, 10_000);

test('after the message, the network coming back is asked at once, not waited out', async () => {
	// A plain Wi-Fi drop fires `online` when it comes back; the next 1.5 s retry must not stand between the two.
	const t0 = Date.now();
	const r = room([() => (Date.now() - t0 < 4500 ? NETWORK_DOWN() : JOINED())]);
	const done = r.link.connect();
	await Bun.sleep(4600); // the asks at 2.75 and 4.25 s failed; the next is due at 5.75 s
	window.dispatchEvent(new Event('online'));
	await done;
	expect(r.seen).toEqual(['checking', 'unreachable', 'joined']);
	expect(Date.now() - t0, 'waited out the retry after `online`').toBeLessThan(5100);
}, 10_000);

test('once the message is up, a party that comes back is noticed within about 1.5 s', async () => {
	// No `online` here: a captive portal or a restarting server never fires one.
	const t0 = Date.now();
	const r = room([() => (Date.now() - t0 < 4000 ? NETWORK_DOWN() : JOINED())]);
	await r.link.connect();
	expect(r.seen).toEqual(['checking', 'unreachable', 'joined']);
	expect(Date.now() - t0, 'still "can\'t reach" over a party that answers').toBeLessThan(5600);
}, 10_000);

test('a server that stays down is not hammered: after 3 s, asks 1.4 s apart or more, at most 9 in 15 s', async () => {
	const at: number[] = [];
	const t0 = Date.now();
	const r = room([
		() => {
			at.push(Date.now() - t0);
			return NETWORK_DOWN();
		}
	]);
	void r.link.connect();
	await Bun.sleep(15_000);
	r.link.close();
	const late = at.filter((t) => t >= 3000);
	expect(late.length, `asked at ${at.join(', ')} ms`).toBeLessThanOrEqual(9);
	expect(late.length, 'stopped asking after the 3 s mark').toBeGreaterThanOrEqual(1);
	for (let k = 1; k < late.length; k++)
		expect(late[k]! - late[k - 1]!, `asked at ${at.join(', ')} ms`).toBeGreaterThanOrEqual(1400);
}, 20_000);

// A captive portal or hotel login page answers 200 to every URL; a broken proxy may answer 200 with no singer.
for (const [what, body] of [
	['an HTML login page', () => new Response('<html>Sign in to Hotel Wi-Fi</html>', { status: 200 })],
	['{"singer": null}', () => Response.json({ singer: null })],
	['a singer with no string id', () => Response.json({ singer: { id: 5, displayName: 'Maya' } })]
] as const) {
	test(`a 200 with ${what} is not an answer: unreachable, still asking, and joined once the network is back`, async () => {
		const t0 = Date.now();
		const r = room([() => (Date.now() - t0 < 3500 ? body() : JOINED())]);
		const done = r.link.connect();
		await Bun.sleep(3200);
		expect(r.link.status).toBe('unreachable');
		await done;
		expect(r.link.status).toBe('joined');
		expect(r.seen).toEqual(['checking', 'unreachable', 'joined']);
		await Bun.sleep(150); // the socket's upgrade lands
		expect(r.sockets()).toBe(1);
	}, 10_000);
}

test('a 4xx other than 401 is not "not joined": a proxy or a portal said it, not the room', async () => {
	const r = room([() => new Response('not found', { status: 404 }), JOINED]);
	await r.link.connect();
	expect(r.seen).toEqual(['checking', 'joined']);
	expect(r.asked()).toBe(2);
});

test('the placeholder waits out the grace, so a quick answer paints no shell at all', async () => {
	const quick = room([() => new Response('', { status: 401 })]);
	let shown = false;
	quick.link.subscribe(() => (shown ||= quick.link.placeholder));
	await quick.link.connect();
	await Bun.sleep(400);
	expect(shown, 'a 401 inside the grace painted the placeholder').toBe(false);

	const slow = room([NETWORK_DOWN, NETWORK_DOWN, NETWORK_DOWN, JOINED]); // answers at 0.75 s
	const done = slow.link.connect();
	await Bun.sleep(200);
	expect(slow.link.placeholder, 'shown inside the grace').toBe(false);
	await Bun.sleep(250);
	expect(slow.link.placeholder, 'not shown past the grace').toBe(true);
	await done;
	expect(slow.link.placeholder, 'still shown once joined').toBe(false);
});

test('"Reconnecting…" is for a socket that dropped, not for the handshake of every cold load', async () => {
	let open: { close(): void } | undefined;
	const server = Bun.serve({
		port: 0,
		fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no', { status: 404 })),
		websocket: { open: (ws) => void (open = ws), message() {} }
	});
	restore.push(() => server.stop(true));
	stub('window', new EventTarget());
	stub('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
	stub('location', { protocol: 'http:', host: `127.0.0.1:${server.port}` });
	stub('fetch', (url: string | URL) =>
		Promise.resolve(String(url).startsWith('/api/me') ? JOINED() : Response.json({ library: [] }))
	);
	const link = new RoomLink();
	restore.push(() => link.close());
	let flashed = false;
	link.subscribe(() => (flashed ||= link.offline));
	await link.connect();
	for (let t = 0; t < 40 && !link.connected; t++) await Bun.sleep(25);
	expect(link.connected).toBe(true);
	expect(flashed, 'the cold-load handshake showed the cue').toBe(false);
	open!.close();
	for (let t = 0; t < 40 && link.connected; t++) await Bun.sleep(10);
	expect(link.offline, 'a real drop showed no cue').toBe(true);
	for (let t = 0; t < 60 && !link.connected; t++) await Bun.sleep(25);
	expect(link.offline, 'the cue outlived the reconnect').toBe(false);
});

test('a socket that never comes up gets the cue after 3 s', async () => {
	const r = room([JOINED]);
	stub('location', { protocol: 'http:', host: '127.0.0.1:9' }); // nothing listens there
	await r.link.connect();
	await Bun.sleep(2800);
	expect(r.link.offline).toBe(false);
	await Bun.sleep(400);
	expect(r.link.offline).toBe(true);
}, 10_000);

test('a quick answer never flashes unreachable', async () => {
	const r = room([() => new Response('', { status: 503 }), JOINED]);
	await r.link.connect();
	await Bun.sleep(3100);
	expect(r.seen).toEqual(['checking', 'joined']);
}, 10_000);

test('a request that never returns is cut off and asked again', async () => {
	// Answers only by honouring the abort signal, like a request to a box that took the SYN and went quiet.
	const hang = (init?: RequestInit) =>
		new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
	const r = room([JOINED]);
	const answered = globalThis.fetch;
	let first = true;
	stub('fetch', (url: string | URL, init?: RequestInit) => {
		if (String(url).startsWith('/api/me') && first) {
			first = false;
			return hang(init);
		}
		return answered(url, init);
	});
	const done = r.link.connect();
	// The hung ask is still in flight at 3 s; it gets IN_FLIGHT_GRACE_MS, not its whole 5 s timeout.
	await Bun.sleep(4300);
	expect(r.link.status, 'a hung ask held the message back past 4 s').toBe('unreachable');
	await done;
	expect(r.link.status).toBe('joined');
	expect(r.seen).toEqual(['checking', 'unreachable', 'joined']);
}, 10_000);

test('an ask in flight at 3 s that then fails shows the message at once', async () => {
	const t0 = Date.now();
	const r = room([() => (Date.now() - t0 < 2600 ? NETWORK_DOWN() : Bun.sleep(600).then(NETWORK_DOWN))]);
	void r.link.connect();
	await Bun.sleep(3600); // the slow ask failed at about 3.35 s
	expect(r.link.status).toBe('unreachable');
}, 10_000);

test('closing the link while it is still asking stops the asking', async () => {
	const r = room([NETWORK_DOWN]);
	const done = r.link.connect();
	await Bun.sleep(100);
	const asked = r.asked(); // one ask is out and failed; the retry is waiting
	r.link.close();
	await done;
	await Bun.sleep(1200);
	expect(r.asked(), 'asked again after close()').toBe(asked);
	expect(r.sockets()).toBe(0);
});

test('coming back to the page after the message is asked at once, not waited out', async () => {
	// A captive portal never fires `online`; the guest signs in elsewhere and returns to the browser.
	const t0 = Date.now();
	const r = room([() => (Date.now() - t0 < 4500 ? NETWORK_DOWN() : JOINED())]);
	const done = r.link.connect();
	await Bun.sleep(4600); // the asks at 2.75 and 4.25 s failed; the next is due at 5.75 s
	const doc = document as unknown as { visibilityState: string };
	doc.visibilityState = 'hidden'; // going away is not coming back
	document.dispatchEvent(new Event('visibilitychange'));
	await Bun.sleep(150);
	expect(r.link.status, 'asked when the page went away').toBe('unreachable');
	doc.visibilityState = 'visible';
	document.dispatchEvent(new Event('visibilitychange'));
	await done;
	expect(r.seen).toEqual(['checking', 'unreachable', 'joined']);
	expect(Date.now() - t0, 'waited out the retry after the page came back').toBeLessThan(5300);
}, 10_000);

/** An EventTarget that counts the wake listeners the retry sleep adds and removes. */
class CountingTarget extends EventTarget {
	live = 0;
	peak = 0;
	override addEventListener(
		t: string,
		l: EventListenerOrEventListenerObject | null,
		o?: AddEventListenerOptions
	): void {
		if (t === 'online' || t === 'visibilitychange') this.peak = Math.max(this.peak, ++this.live);
		super.addEventListener(t, l, o);
	}
	override removeEventListener(
		t: string,
		l: EventListenerOrEventListenerObject | null,
		o?: EventListenerOptions
	): void {
		if (t === 'online' || t === 'visibilitychange') this.live--;
		super.removeEventListener(t, l, o);
	}
}

test('a long outage holds at most one wake listener each, and none once closed', async () => {
	// From the round-3 review's probe: a retry sleep that forgot to remove its listener left one per retry.
	const win = new CountingTarget();
	const doc = Object.assign(new CountingTarget(), { visibilityState: 'visible' });
	stub('window', win);
	stub('document', doc);
	stub('location', { protocol: 'http:', host: '127.0.0.1:1' });
	stub('fetch', () => NETWORK_DOWN());
	const link = new RoomLink();
	restore.push(() => link.close());
	void link.connect();
	await Bun.sleep(6000);
	expect(win.peak, 'online listeners piled up across retries').toBe(1);
	expect(doc.peak, 'visibilitychange listeners piled up across retries').toBe(1);
	link.close();
	await Bun.sleep(1700); // the sleep in flight wakes on its own timer
	expect(win.live).toBe(0);
	expect(doc.live).toBe(0);
}, 15_000);
