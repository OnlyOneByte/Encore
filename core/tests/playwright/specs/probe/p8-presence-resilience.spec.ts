// PRESENCE, JOIN, AND REALTIME RESILIENCE: phones stay in sync across disconnects.
//
// PRESENCE IS "HAS AN OPEN SOCKET", AND `away` IS DISTINCT FROM GONE. A singer in the room but unreachable — a
// locked phone, a pocket — is counted AWAY: greyed on the TV, still holding their place and their songs.
// Nothing on the wire announces "gone", so departure is decided by a GRACE CLOCK that the 20s membership sweep
// (server.ts:MEMBERSHIP_SWEEP_MS) advances, while `here`/`away` move on socket EDGES and broadcast at once
// (server.ts open/close → refreshMembership). Every claim below lives on the edge half, which is why no test
// here waits out a sweep.
//
// NO GRACE SETTING IS WRITTEN, AND THAT IS THE POINT. `presenceGraceMinutes` defaults to 90, so a test of the
// `gone` transition would have to shorten it rather than wait — but p8 never tested `gone`. Its away arm
// deliberately leaves a QUEUED SONG in the room, and the clock does not start while a singer holds pending
// songs (contract/queue/membership.ts), so the 90 minutes are unreachable by construction and irrelevant to
// what is asserted. Named here so a reader does not go looking for the setting.
//
// TEN PHONES AND NOT TWENTY, in the one test that wants a full room: a browser CONTEXT per phone costs memory
// and file descriptors, and every failure class here shows up at 8-10. Every other test opens the minimum the
// claim needs, because a core boots per test.
//
// WHY CONTEXTS, NOT `world.openPhone`, FOR THE DROP TESTS. Two instruments are needed and both are per-context:
// `context.setOffline(true)` blocks ONE guest's re-dial while the rest of the room stays up, and an init script
// wrapping `window.WebSocket` is what lets a test hard-drop the socket the app opened and count its
// reconnects. A browser WebSocket has no "abort", so `close(3000)` is the closest thing to a signal drop from
// the JS side: the client's onclose fires and the reconnect path takes over. The wrapper passes send/close
// straight through, so it adds no observable behaviour.
//
// ORDER IS LOAD-BEARING WHEREVER BOTH ARE USED: drop the socket BEFORE going offline. Offline first swallows
// the close frame, and the server then waits out its own 30s idleTimeout instead of learning the phone went
// away — which is a different test with a different answer.
//
// THE ROSTER OVERFLOW CHECKS ARE DEAD, AND ARE REPLACED BY THE CLAIM THEY PROTECTED. p8 asserted the TV shows
// "8 named chips + a '+N more' chip" and that the overflow number agrees with the roster. Neither can be
// measured now: routes/tv/+page.svelte:364 passes `Infinity` as the cap ("The WHOLE roster, no '+N more'") and
// TvLobby steps the chip size down instead, so `.person.more` renders nowhere and an 8-chip cap does not
// exist. Both were MEDIUM findings — below p8's own exit-1 threshold, so they never failed it. What they were
// protecting is stated in p8's own words: "a cap with no overflow chip vanished guests 9+". So the ported
// assertion is that TEN present singers produce TEN chips and no `.more` chip at all, which fails on either
// half — a silent cap, or a resurrected overflow chip. Flagged rather than ported verbatim into red.
//
// ALSO GONE: p8's own emptiness gate ("server was not empty at start of run", an ENV finding). The `world`
// fixture reads the room code off the attract panel before anything joins and throws with the remedy if it
// cannot, so the condition is checked earlier and louder than a probe step could.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { goOffline, openBrowseFromHome, openQueue, queueReady, readySong } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

const PHONE = { width: 390, height: 844 };
const NUM_PHONES = 10;
const NUM_BURST = 6;
/** One distinct name per phone: a reused name is a 409 and the join page simply stays put. */
const PHONE_NAMES = ['Ada', 'Bea', 'Cai', 'Deb', 'Eve', 'Fin', 'Gio', 'Han', 'Ira', 'Jos'];
/** A LOCAL song: a cold yt-dlp miss takes long enough to read as the queue losing rows. */
const SEARCH_TERM = 'bohemian';
/** 10s covers a full 250ms-backoff cycle plus the hello → queue:sync handshake. */
const RECONNECT_TIMEOUT = 10_000;
/** p8's own ceiling for a presence edge to reach the TV. The broadcast is synchronous with the close, so this
 *  is slack, not a duration anything is expected to take. */
const PRESENCE_TIMEOUT = 15_000;

/** What the init script publishes on `window`. */
interface SocketProbe {
	connectCount: number;
	/** `queue:sync` frames seen — the store's rebase signal, and the only honest "this phone is ready to tap". */
	syncCount: number;
	dropLast(): boolean;
}
type ProbedWindow = Window & { __p8: SocketProbe };

/**
 * Runs before app code on every load, recording every socket the client opens so a test can hard-drop one or
 * watch it reconnect. `syncCount` is this port's addition and it replaces a 400ms sleep: p8 slept because "a
 * phone that taps before its store has observed the sync-time rebase misses its own row", which is a real
 * protocol event and not a duration, so it is counted instead of waited out.
 */
function instrumentSockets(): void {
	const Original = window.WebSocket;
	const probe: SocketProbe & { lastOpen: WebSocket | null } = {
		lastOpen: null,
		connectCount: 0,
		syncCount: 0,
		dropLast() {
			const s = this.lastOpen;
			if (!s || s.readyState > 1) return false;
			s.close(3000, 'p8-drop');
			return true;
		}
	};
	(window as unknown as ProbedWindow).__p8 = probe;
	function Wrapped(url: string | URL, protocols?: string | string[]): WebSocket {
		const s = protocols === undefined ? new Original(url) : new Original(url, protocols);
		probe.lastOpen = s;
		s.addEventListener('open', () => {
			probe.connectCount++;
		});
		s.addEventListener('message', (ev: MessageEvent) => {
			try {
				if ((JSON.parse(String(ev.data)) as { type?: string })?.type === 'queue:sync') probe.syncCount++;
			} catch {
				/* not JSON, or not ours */
			}
		});
		return s;
	}
	Wrapped.prototype = Original.prototype;
	Object.assign(Wrapped, {
		CONNECTING: Original.CONNECTING,
		OPEN: Original.OPEN,
		CLOSING: Original.CLOSING,
		CLOSED: Original.CLOSED
	});
	window.WebSocket = Wrapped as unknown as typeof WebSocket;
}

const connectCount = (page: Page): Promise<number> =>
	page.evaluate(() => (window as unknown as ProbedWindow).__p8.connectCount);
const syncCount = (page: Page): Promise<number> =>
	page.evaluate(() => (window as unknown as ProbedWindow).__p8.syncCount);
const dropSocket = (page: Page): Promise<boolean> =>
	page.evaluate(() => (window as unknown as ProbedWindow).__p8.dropLast());
/**
 * The phone's RENDERED rotation count, and it takes the phone to the Queue tab to read it — see repair (3) in the
 * header. Every call site here is a witness asking "does this phone see the row", and none of them has any reason
 * to be on /queue already, so putting the route in the reader is what makes them correct by construction rather
 * than by each remembering. Cheap to repeat inside a poll: `toQueueTab` returns as soon as the pathname matches.
 */
const queueRows = async (page: Page): Promise<number> => {
	await toQueueTab(page);
	return page.locator(SEL.queueRow).count();
};

interface Guest {
	page: Page;
	context: BrowserContext;
	name: string;
}

/** A joined phone on its own context, with its sockets instrumented and its first `queue:sync` observed. */
async function openGuest(browser: Browser, world: World, name: string): Promise<Guest> {
	const context = await browser.newContext({ baseURL: world.baseURL, viewport: PHONE });
	await context.addInitScript(instrumentSockets);
	const page = await context.newPage();
	await world.joinAs(page, name);
	await expect
		.poll(() => syncCount(page), { message: `${name} joined but its store never observed a queue:sync` })
		.toBeGreaterThan(0);
	return { page, context, name };
}

async function openGuests(browser: Browser, world: World, names: string[]): Promise<Guest[]> {
	const guests: Guest[] = [];
	for (const name of names) guests.push(await openGuest(browser, world, name));
	return guests;
}

/**
 * Search, take the first row's action for real, then come back to the queue and confirm the row landed.
 *
 * TWO REPAIRS TO THE INSTRUMENT, both reported rather than quiet. (1) p8 clicked TWICE through `el.click()`
 * because "results shuffling in the same tick replace the button with an identical-looking one that carries the
 * live handler", and a synthetic click on a dead node is silently lost. Playwright's own input waits for the
 * element to be stable and hit-testable before it dispatches, and it is a TRUSTED event, so the retry, the
 * diagnostic dump and the `el.click()` go away together. (2) p8 counted `.qrow` WITH THE SEARCH STILL UP — but
 * `src/routes/+page.svelte` gates the whole Queued block on `{#if !searchActive}` ("One scroll, two views"), so
 * that count is 0 on any phone showing results, whatever landed. Its helper could therefore only ever report
 * "clicked but no local row", which is why p8's later steps all degrade to ENV findings. The MEASUREMENT is
 * unchanged — the phone's own `.qrow` count, before and after — and the way to the queue is the real one.
 * (3) THAT WAY IS NOW A ROUTE. `.qrow` is on /queue; the Sing tab renders no queue rows at all, so clearing the
 * search box no longer reveals a rotation and every count here read 0 whatever landed — the same false reading
 * repair (2) was written to remove, arriving by a different door. `toQueueTab` and `toSingTab` below move between
 * them, and they CLICK rather than `goto` on purpose: the offline arm of this file taps with the network down, and
 * a full document load would fail where a client-side route change does not.
 *
 * `world.awaitDemoTrack` comes first because the phone's search fires ONCE per keystroke burst: the library scan
 * is a detached boot pass that finishes after /health answers, so a phone that types too early gets an answer
 * from an empty index and nothing re-runs the query. A locator would wait for a row that is never coming.
 */
/** To the QUEUE tab, by clicking — see repair (3) above. Clears any query first, so the Sing tab is left on its
 *  idle state and a later `toSingTab` is not re-running somebody else's search. */
async function toQueueTab(page: Page): Promise<void> {
	if ((await page.locator(SEL.clearSearch).count()) > 0) await page.locator(SEL.clearSearch).first().click();
	await openQueue(page);
}

/** To the SING tab, which is where the search field is, by clicking its tab when the phone is elsewhere. */
async function toSingTab(page: Page): Promise<void> {
	if (new URL(page.url()).pathname !== '/') {
		await page.locator(SEL.tab).filter({ hasText: 'Sing' }).first().click();
		await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
	}
	await openBrowseFromHome(page);
}

async function searchAndQueue(world: World, page: Page, term: string = SEARCH_TERM): Promise<void> {
	await world.awaitDemoTrack(term);
	// Counted on /queue, which is where the rotation is rendered at all.
	await toQueueTab(page);
	const before = await queueRows(page);
	await toSingTab(page);
	await page.locator(SEL.search).fill(term);
	// The library tracks are raw, so the action a row offers may be SING rather than add — the union asks
	// whether the row offers an action AT ALL, which is p8's own question.
	await page.locator(SEL.songRow).first().locator(SEL.addOrSing).first().click();
	await toQueueTab(page);
	await expect
		.poll(() => queueRows(page), {
			timeout: 20_000,
			message: `tapping the first row for "${term}" produced no queue row on the phone that tapped it`
		})
		.toBeGreaterThan(before);
}

interface RosterChip {
	name: string;
	away: boolean;
	/** The retired overflow chip. Read so its ABSENCE can be asserted — see the header. */
	more: boolean;
	text: string;
}
interface TvRoster {
	chips: RosterChip[];
	screen: 'transient' | 'playing' | 'lobby' | 'attract';
}

/** The TV's roster and which screen it is on, in one round trip. p8's derivation, unchanged. */
async function tvRoster(tv: Page): Promise<TvRoster> {
	return tv.evaluate(
		({ stripPerson, anyTransientState, lowerThird }) => {
			const chips: RosterChip[] = [...document.querySelectorAll(stripPerson)].map((el) => ({
				name: (el.childNodes[1]?.textContent || el.textContent || '').trim(),
				away: el.classList.contains('away'),
				more: el.classList.contains('more'),
				text: (el.textContent || '').trim()
			}));
			const screen = document.querySelector(anyTransientState)
				? 'transient'
				: document.querySelector(lowerThird)
					? 'playing'
					: document.querySelector(stripPerson)
						? 'lobby'
						: 'attract';
			return { chips, screen } as TvRoster;
		},
		{ stripPerson: SEL.stripPerson, anyTransientState: SEL.anyTransientState, lowerThird: SEL.lowerThird }
	);
}

/** One named chip's away state, or null when the TV is not showing that person at all. */
async function chipAway(tv: Page, name: string): Promise<boolean | null> {
	const roster = await tvRoster(tv);
	return roster.chips.find((c) => c.text.includes(name))?.away ?? null;
}

/**
 * p8's three-branch join outcome, as one expression so a 409 and a clean join cannot be confused.
 *
 * NEVER THROWS, for the reason `isJoined` in world/actors.ts states: a successful join RELOADS `/` by hand (a
 * client-side goto from `/` to `/` is a no-op), and a reload in flight destroys the execution context — so an
 * exception here would end the very poll that is waiting for that reload to finish. Swallowed as "not settled
 * yet", which is exactly what it means.
 */
async function joinOutcome(page: Page): Promise<string | null> {
	try {
		return await page.evaluate(
			({ dock, joinError }) => {
				if (location.pathname === '/' && document.querySelector(dock)) return 'joined';
				const err = document.querySelector(joinError);
				if (err) return 'err:' + (err.textContent || '').trim();
				return null;
			},
			{ dock: SEL.dock, joinError: SEL.joinError }
		);
	} catch {
		return null;
	}
}

async function settledJoinOutcome(page: Page, who: string): Promise<string> {
	await expect
		.poll(() => joinOutcome(page), { timeout: 8_000, message: `${who}'s join neither landed nor errored` })
		.not.toBeNull();
	return (await joinOutcome(page)) ?? 'none';
}

// ── 1. a full room ───────────────────────────────────────────────────────────────────────────────────────

test('ten joined phones each hold a session, and the TV names every one of them', async ({ browser, world }) => {
	const tv = await world.openTv();
	const guests = await openGuests(browser, world, PHONE_NAMES.slice(0, NUM_PHONES));
	try {
		// Waited on, not slept at: the last connect has to reach the TV before the roster is read, and the chip
		// count IS that condition.
		await expect(tv.locator(SEL.stripPerson)).toHaveCount(NUM_PHONES, { timeout: PRESENCE_TIMEOUT });
		const roster = await tvRoster(tv);

		// Still `attract` with singers present would mean the roster broadcast dropped one.
		expect(roster.screen, `the TV did not enter the lobby after ${NUM_PHONES} joins`).toBe('lobby');
		expect(
			roster.chips.filter((c) => !c.more).length,
			`the TV must name every present singer — a cap with no overflow chip vanishes guests 9+. ` +
				`chips=${JSON.stringify(roster.chips.map((c) => c.name))}`
		).toBe(NUM_PHONES);
		expect(
			roster.chips.filter((c) => c.more),
			'no chip may carry the retired `.more` class: the lobby truncates nothing (tv/+page.svelte passes ' +
				'Infinity as the cap), so a "+N more" chip reappearing means the roster is being capped again'
		).toEqual([]);

		// The phone renders no lobby and its store is not exposed, so read the session off /api/me. Through the
		// PAGE's request context, so each carries its own singer cookie.
		const sessions = await Promise.all(
			guests.map(async (g) => {
				const res = await g.page.request.get('/api/me');
				const body = res.ok() ? ((await res.json()) as { singer?: { displayName?: string } }) : { singer: null };
				return { name: g.name, hasMe: !!body.singer };
			})
		);
		expect(
			sessions.filter((s) => s.hasMe).map((s) => s.name),
			`not every phone confirmed a joined session — src/routes/api/me/+server.ts`
		).toEqual(guests.map((g) => g.name));
	} finally {
		for (const g of guests) await g.context.close();
	}
});

// ── 2. a duplicate name ──────────────────────────────────────────────────────────────────────────────────

// ONE test, four assertions: a 409 that leaves the form unusable looks exactly like a broken app, so "refused"
// and "recoverable" are halves of one sequence and the retype only means anything after the refusal.
test('a duplicate display name is refused in human words, and the form recovers', async ({ browser, world }) => {
	const held = await openGuest(browser, world, PHONE_NAMES[0]!);
	const context = await browser.newContext({ baseURL: world.baseURL, viewport: PHONE });
	try {
		const page = await context.newPage();
		await page.goto(`/?room=${encodeURIComponent(world.code)}`);
		await page.locator(SEL.nameInput).fill(PHONE_NAMES[0]!);
		await page.getByRole('button', { name: SEL.submit }).click();

		const outcome = await settledJoinOutcome(page, `a second phone claiming "${PHONE_NAMES[0]}"`);
		expect(
			outcome,
			`the name "${PHONE_NAMES[0]}" was reused and the server accepted it — ` +
				`src/lib/server/singers/join.ts assertNameFree`
		).not.toBe('joined');

		const message = outcome.replace(/^err:/, '');
		expect(
			/taken/i.test(message) || /already/i.test(message),
			`the name-collision error is not human-legible. The phone displayed: ${JSON.stringify(message)} — ` +
				`src/lib/server/singers/join.ts NameTakenError`
		).toBe(true);

		const usable = await page.evaluate(
			({ nameInput, joinError }) => {
				const nameEl = document.querySelector<HTMLInputElement>(nameInput);
				const alertEl = document.querySelector(joinError);
				const btn = [...document.querySelectorAll('button')].find((b) => {
					const t = (b.textContent ?? '').trim();
					return t.startsWith('Start singing') || t.startsWith('Joining');
				});
				return {
					nameStillEditable: !!nameEl && !nameEl.disabled,
					errorAnnounced: !!alertEl && !!alertEl.getAttribute('role'),
					submitReachable: !!btn && !btn.disabled
				};
			},
			{ nameInput: SEL.nameInput, joinError: SEL.joinError }
		);
		expect(usable, 'the form must let the user retype and resubmit — src/lib/components/JoinLanding.svelte').toEqual({
			nameStillEditable: true,
			errorAnnounced: true,
			submitReachable: true
		});

		// Retype and resubmit for real, through the same controls a guest would use.
		await page.locator(SEL.nameInput).fill('ZZReplay');
		await page.getByRole('button', { name: SEL.submit }).click();
		expect(
			await settledJoinOutcome(page, 'the retyped join'),
			'the form did not recover after fixing the name: the submit never landed in the party'
		).toBe('joined');
	} finally {
		await context.close();
		await held.context.close();
	}
});

// ── 3. a hard socket drop with the page still resident ───────────────────────────────────────────────────

// ONE test: a reconnect only means something end to end. The socket coming back proves the dialler; a row
// queued WHILE the victim was down is what proves the resync.
test('a hard-dropped phone reconnects and resyncs to the authoritative queue', async ({ browser, world }) => {
	// A mid-list phone, so the drop is not at a boundary that might be special-cased.
	const [victim, witness] = await openGuests(browser, world, ['Deb', 'Fin']);
	try {
		const before = await connectCount(victim!.page);
		expect(
			await dropSocket(victim!.page),
			'could not drop the phone WebSocket: no socket was open, so there is nothing to reconnect'
		).toBe(true);

		await expect
			.poll(() => connectCount(victim!.page), {
				timeout: RECONNECT_TIMEOUT,
				message:
					`the phone did not reconnect after a WebSocket drop: connectCount stayed at ${before} — ` +
					`src/lib/ws/client.ts scheduleReconnect + capped backoff`
			})
			.toBeGreaterThan(before);

		await searchAndQueue(world, witness!.page);
		const witnessRows = await queueRows(witness!.page);
		// Parity means nothing until the witness confirms a row landed at all.
		expect(
			witnessRows,
			'the queue-add on the witness phone produced no row, so there is nothing for the victim to resync TO ' +
				'— src/lib/stores/queue.ts #optimistic'
		).toBeGreaterThanOrEqual(1);

		await expect
			.poll(() => queueRows(victim!.page), {
				message:
					`the reconnected phone did not resync the queue — src/lib/stores/queue.ts #onSync (rebase on ` + `queue:sync)`
			})
			.toBe(witnessRows);
	} finally {
		for (const g of [victim, witness]) await g?.context.close();
	}
});

// ── 4. severed without leaving ───────────────────────────────────────────────────────────────────────────

// ONE test, three assertions, and they are one sequence: away, then the song surviving away, then coming back.
// Split, the middle one would have to re-establish the away state it is about.
test('a severed phone shows as AWAY, keeps its queued song, and returns as here', async ({ browser, world }) => {
	const tv = await world.openTv();
	const [away, observer] = await openGuests(browser, world, ['Han', 'Cai']);
	try {
		await searchAndQueue(world, away!.page, 'caroline');
		await expect(tv.locator(SEL.stripPerson)).toHaveCount(2, { timeout: PRESENCE_TIMEOUT });
		const beforeConnects = await connectCount(away!.page);

		// ORDER IS LOAD-BEARING — see the header. Sever first, then block the re-dial.
		expect(await dropSocket(away!.page), 'could not sever the away phone: no socket to drop').toBe(true);
		await goOffline(away!.page);

		await expect
			.poll(() => chipAway(tv, away!.name), {
				timeout: PRESENCE_TIMEOUT,
				message:
					`the TV's roster never marked ${away!.name} as away — presence.disconnect should broadcast ` +
					`near-instantly on close(3000). src/lib/server/realtime/presence.ts disconnect; server.ts close()`
			})
			.toBe(true);

		// A locked phone keeping its turn is the whole point of `away`.
		expect(
			await queueRows(observer!.page),
			`the severed phone LOST its queued song: another phone sees no queue row. The disconnected singer's ` +
				`song must survive — src/lib/server/realtime/presence.ts (the grace clock does not start while ` +
				`pending songs exist)`
		).toBeGreaterThanOrEqual(1);

		await away!.context.setOffline(false);
		await expect
			.poll(() => connectCount(away!.page), {
				timeout: PRESENCE_TIMEOUT,
				message: `the away phone never re-dialled once the network came back — src/lib/ws/client.ts wake()`
			})
			.toBeGreaterThan(beforeConnects);
		await expect
			.poll(() => chipAway(tv, away!.name), {
				timeout: PRESENCE_TIMEOUT,
				message:
					`the TV chip for ${away!.name} stayed grey after the network came back — ` +
					`src/lib/server/realtime/presence.ts connect()`
			})
			.toBe(false);
	} finally {
		for (const g of [away, observer]) await g?.context.close();
	}
});

// ── 5. an optimistic op taken while severed ──────────────────────────────────────────────────────────────

// A READY song, so the tap is the plain add (`song-add`), the one op that still rides the socket alone. Sing on an
// unmade song sends `/api/process` first and adds the turn only if it started (src/lib/process-and-queue.ts), so
// an offline Sing gives "Couldn't start that." and no row by design — fresh-pick-every-phone covers that path.
// The witness puts another ready song ON STAGE first: in an idle room the resent add would start playing at once
// and leave the queue rows, reading as a lost add.
test('a queue-add taken while the socket is severed reconciles on reconnect', async ({ browser, world }) => {
	const worker = await startFakeWorker(world);
	const [origin, witness] = await openGuests(browser, world, ['Gio', 'Cai']);
	try {
		for (const q of ['caroline', SEARCH_TERM]) await readySong(world, origin!.page, q);
		await queueReady(witness!.page, 'caroline');
		const before = await queueRows(witness!.page);

		// SEARCH WHILE ONLINE: going offline blocks the HTTP request too, so the row must be up first.
		await toSingTab(origin!.page);
		await origin!.page.locator(SEL.search).fill(SEARCH_TERM);
		const action = origin!.page.locator(SEL.songRow, { hasText: SEARCH_TERM }).locator(SEL.addAction).first();
		await expect(action, `no ready add row for "${SEARCH_TERM}" before the offline test`).toBeVisible();

		const beforeConnects = await connectCount(origin!.page);
		expect(await dropSocket(origin!.page), 'could not sever the origin phone: no socket to drop').toBe(true);
		await goOffline(origin!.page);

		// A REAL tap on a severed phone: the send lands on a closed socket, so the op stays pending and only the
		// local row shows.
		await action.click();
		// BOTH STEPS ARE CLIENT-SIDE — no request — so they work with the network down: clearing the box is a local
		// state write, and the Queue tab is an `<a>` SvelteKit intercepts. That matters here and nowhere else in this
		// file: a `goto` would try to fetch a document from a severed network.
		await toQueueTab(origin!.page);
		// `.proc` is a SUBSET of `.qrow`, so this sum double-counts — deliberately, and p8's own measurement: the
		// question is whether ANY local row appeared, never an exact total.
		const optimistic =
			(await origin!.page.locator(SEL.queueRow).count()) + (await origin!.page.locator(SEL.processing).count());
		expect(
			optimistic,
			'the offline tap produced no optimistic row: the store must render locally before hearing back from ' +
				'the server — src/lib/stores/queue.ts #optimistic'
		).toBeGreaterThan(0);

		await origin!.context.setOffline(false);
		await expect
			.poll(() => connectCount(origin!.page), {
				timeout: PRESENCE_TIMEOUT,
				message: 'the origin phone never re-dialled once the network came back'
			})
			.toBeGreaterThan(beforeConnects);

		// Reconciled means the op made it through the pending resend that follows queue:sync. A witness delta of
		// 0 with a row still on the origin is the silent-loss case: a phantom local row and nothing on the server.
		await expect
			.poll(() => queueRows(witness!.page), {
				timeout: PRESENCE_TIMEOUT,
				message:
					`the offline queue-add never reached the room — src/lib/ws/client.ts trySend drops on non-open; ` +
					`src/lib/stores/queue.ts pending map`
			})
			.toBe(before + 1);
		expect(
			await queueRows(origin!.page),
			'the offline queue-add reconciled but the origin disagrees with the room: a phantom local row survived ' +
				'reconcile — src/lib/stores/queue.ts #onPatch / #onSync rebase'
		).toBe(before + 1);
	} finally {
		for (const g of [origin, witness]) await g?.context.close();
		await worker.stop();
	}
});

// ── 6. an explicit leave ─────────────────────────────────────────────────────────────────────────────────

test('/api/leave un-queues that singer’s pending songs and frees the name', async ({ browser, world }) => {
	const [leaver, observer] = await openGuests(browser, world, ['Eve', 'Cai']);
	try {
		await searchAndQueue(world, leaver!.page, 'caroline'); // so leave has real songs to handle
		await expect
			.poll(() => queueRows(observer!.page), { message: 'the leaver’s song never reached the other phone' })
			.toBeGreaterThanOrEqual(1);
		const beforeCount = await queueRows(observer!.page);

		// GET reports what a leave would COST, so the phone can name the consequence in its confirm.
		const preview = (await (await leaver!.page.request.get('/api/leave')).json()) as {
			queuedCount?: number;
			hasPlaying?: boolean;
		};
		const leaveRes = await leaver!.page.request.post('/api/leave');
		expect(leaveRes.status(), '/api/leave returned an error').toBe(200);
		const result = (await leaveRes.json()) as { removed?: string[] };
		const removed = result.removed?.length ?? NaN;

		await expect
			.poll(() => queueRows(observer!.page).then((after) => beforeCount - after), {
				message:
					`leave removed fewer rows from the room than the API reported (api removed=${removed}, ` +
					`previewQueued=${preview.queuedCount}, hasPlaying=${preview.hasPlaying}) — ` +
					`src/lib/server/singers/leave.ts doLeave`
			})
			.toBeGreaterThanOrEqual(removed);

		// The name must return to the pool immediately: telling us removes the ambiguity the grace window exists
		// for — src/lib/server/realtime/presence.ts forget.
		const rejoin = await browser.newContext({ baseURL: world.baseURL, viewport: PHONE });
		try {
			const page = await rejoin.newPage();
			await page.goto(`/?room=${encodeURIComponent(world.code)}`);
			await page.locator(SEL.nameInput).fill(leaver!.name);
			await page.getByRole('button', { name: SEL.submit }).click();
			expect(
				await settledJoinOutcome(page, `a rejoin as "${leaver!.name}"`),
				'the name did not return to the pool after a leave'
			).toBe('joined');
		} finally {
			await rejoin.close();
		}
	} finally {
		for (const g of [leaver, observer]) await g?.context.close();
	}
});

// ── 7. a burst of simultaneous adds ──────────────────────────────────────────────────────────────────────

test(`${NUM_BURST} phones queueing at once converge on one queue`, async ({ browser, world }) => {
	// NUM_BURST shooters plus one phone that never taps. EVERY joined phone is read, because an origin renders
	// its own row — a population of nothing but origins would look correct with every broadcast lost.
	const names = ['Ada', 'Bea', 'Cai', 'Deb', 'Eve', 'Fin', 'Gio'].slice(0, NUM_BURST + 1);
	const guests = await openGuests(browser, world, names);
	try {
		const shooters = guests.slice(0, NUM_BURST);
		expect(shooters, `the burst needs ${NUM_BURST} joined shooters`).toHaveLength(NUM_BURST);
		const before = await queueRows(shooters[0]!.page);

		// All taps in one turn; each page mints its own clientOpId and entry id.
		await Promise.all(shooters.map((g) => searchAndQueue(world, g.page, 'caroline')));

		const expected = before + NUM_BURST;
		await expect
			.poll(
				async () => {
					const counts = await Promise.all(guests.map((g) => queueRows(g.page)));
					return [...new Set(counts)];
				},
				{
					timeout: 30_000,
					message:
						`the phones never converged on ${expected} rows after a burst of ${NUM_BURST} adds: either they ` +
						`disagree (a lost broadcast — src/lib/server/realtime/hub.ts handleQueueCommand) or they agree on ` +
						`the wrong number (lost or duplicated rows — src/lib/server/state/store.ts applyQueueOp)`
				}
			)
			.toEqual([expected]);

		// A duplicated row under a different id sums to the same count, so the titles are reported too. Dups are
		// LEGAL — the same media queued by different singers — so this is evidence, not an assertion.
		const titles = await shooters[0]!.page.locator(SEL.queueTitle).allInnerTexts();
		test.info().annotations.push({
			type: 'burst',
			description: `titles=${titles.length}, unique=${new Set(titles.map((t) => t.trim())).size}`
		});
	} finally {
		for (const g of guests) await g.context.close();
	}
});
