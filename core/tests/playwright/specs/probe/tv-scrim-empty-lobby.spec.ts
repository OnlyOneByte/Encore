// THE TAP-TO-START SCRIM MUST NOT OUTLIVE THE ROOM: the autoplay-blocked latch's only two writers are
// per-slot props, so when the room DRAINS both players unmount, neither can fire again, and a scrim gated
// on that latch alone covers the lobby of an EMPTY room above its own join QR. Only a rendered rung can see
// it — the claim is which element is topmost at the join card's centre.
//
// GESTURELESS BY CONSTRUCTION — nothing here taps the TV, which is the premise and not an omission: a
// never-tapped TV is the only TV that reaches this state, and neither input that gets here is a tap. This
// browser cannot refuse autoplay on its own, so the policy is restored in-page by world/autoplay.ts and its
// `autoplayIsBlocked` premise is ASSERTED before any claim about the app's reaction.
import { test, expect, type World } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker, type FakeWorker } from '../../world/workers';
import { openBrowseFromHome, returnHomeFromBrowse } from '../../world/actors';
import { autoplayIsBlocked, requireActivationForPlayback } from '../../world/autoplay';
import type { Page } from '@playwright/test';

/** The song the fixture processes; a substring of the demo library's `sweet-caroline.wav`. */
const SONG = 'caroline';
/** The defect was INDEFINITE, so the clear lobby is re-measured after a dwell rather than trusted on one
 *  frame. This is not a wait for anything to arrive — there is nothing left to arrive. */
const IDLE_DWELL_MS = 5_000;

interface SongRow {
	id: string;
	title: string;
	source: string;
	instrumentalRef?: string | null;
}
interface SearchBody {
	ready: SongRow[];
	processing: SongRow[];
	results: SongRow[];
}

/**
 * Process one local library song and resolve when it is READY with an instrumental to play.
 *
 * `awaitDemoTrack` first, because the library scan is a detached boot pass: the index is empty for seconds after
 * `/health` answers, and a search that lands in that window returns nothing with no way to tell "early" from
 * "broken". The process request goes through the PAGE's request context, so it carries that phone's singer
 * cookie — `/api/process` refuses an anonymous caller.
 */
async function processToReady(world: World, page: Page, query: string): Promise<SongRow> {
	const track = await world.awaitDemoTrack(query);
	const res = await page.request.post('/api/process', { data: { mediaId: track.id } });
	if (!res.ok()) throw new Error(`/api/process refused "${query}": ${res.status()} ${await res.text()}`);
	await expect
		.poll(
			async () => {
				const body = (await page.request
					.get(`/api/search?q=${encodeURIComponent(query)}`)
					.then((r) => r.json())) as SearchBody;
				return body.ready.some((r) => r.id === track.id && !!r.instrumentalRef);
			},
			{ timeout: 60_000, message: `"${track.title}" never reached ready with an instrumental ref` }
		)
		.toBe(true);
	return track;
}

interface ScrimReading {
	hint: boolean;
	hintStyle: Record<string, string> | null;
	lobby: boolean;
	card: boolean;
	cardRect: { x: number; y: number; w: number; h: number } | null;
	topAtJoinCard: string | null;
	joinCardReachable: boolean | null;
	mediaCount: number;
	/** Diagnostics, so a failed claim says WHICH screen it measured rather than only what it wanted. */
	screen: string;
	withSrc: number;
}

/**
 * ONE reading, taken identically at every step so before/after is apples-to-apples. `topAtJoinCard` —
 * `elementFromPoint` at the join card's CENTRE — is the load-bearing one, because the guest-visible question
 * is whether somebody walking up can read and use the join affordance. Centre, not a far edge: Chromium
 * hit-tests `border-radius`, so an edge sweep measures the chord through the card's own rounded corner.
 */
async function readScrim(tv: Page): Promise<ScrimReading> {
	return tv.evaluate(
		({ autoplayHint, lobbyUrl, badQr, lobby, mediaEl, attract, stateWaiting, lowerThird }) => {
			const q = (s: string) => document.querySelector(s);
			const hintEl = q(autoplayHint);
			// The affordance is the QR + address, or the operator notice that replaces it on an unroutable origin.
			const card = q(lobbyUrl) ?? q(badQr);
			let top: string | null = null;
			let topIsCard: boolean | null = null;
			let rect: { x: number; y: number; w: number; h: number } | null = null;
			if (card) {
				const r = card.getBoundingClientRect();
				rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
				const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
				top = el ? (typeof el.className === 'string' && el.className ? el.className : el.tagName) : null;
				topIsCard = !!el && (el === card || card.contains(el) || el.contains(card));
			}
			const media = [...document.querySelectorAll<HTMLMediaElement>(mediaEl)];
			const cs = hintEl ? getComputedStyle(hintEl) : null;
			const screen = q(attract)
				? 'attract'
				: q(lobby)
					? 'lobby'
					: q(stateWaiting)
						? 'waiting'
						: q(lowerThird)
							? 'playing'
							: 'unknown';
			return {
				hint: !!hintEl,
				hintStyle: cs
					? {
							position: cs.position,
							zIndex: cs.zIndex,
							inset: cs.inset,
							bg: cs.backgroundColor,
							pe: cs.pointerEvents
						}
					: null,
				lobby: !!q(lobby),
				card: !!card,
				cardRect: rect,
				topAtJoinCard: top,
				joinCardReachable: topIsCard,
				mediaCount: media.length,
				screen,
				withSrc: media.filter((m) => !!(m.currentSrc || m.src)).length
			};
		},
		{
			autoplayHint: SEL.autoplayHint,
			lobbyUrl: SEL.lobbyUrl,
			badQr: SEL.badQr,
			lobby: SEL.lobby,
			mediaEl: SEL.mediaEl,
			attract: SEL.attract,
			stateWaiting: SEL.stateWaiting,
			lowerThird: SEL.lowerThird
		}
	);
}

/**
 * A phone-side socket that RECORDS the server's own playback frames. A phone in BOTH directions in the old
 * probe; here the skip rides the real transport button, so this socket only listens — and that is the half
 * that matters, because it lets the drain be asserted against the SERVER rather than against what the TV
 * happened to draw.
 */
async function observeServerPlayback(phone: Page): Promise<void> {
	await phone.evaluate(async () => {
		const w = window as unknown as { __srv?: { playback: unknown }; __srvWs?: WebSocket };
		if (w.__srvWs && w.__srvWs.readyState === WebSocket.OPEN) return;
		const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=phone`);
		w.__srv = { playback: null };
		ws.onmessage = (ev: MessageEvent<string>) => {
			let m: { type?: string; playback?: unknown; state?: unknown };
			try {
				m = JSON.parse(ev.data) as typeof m;
			} catch {
				return;
			}
			if (m.type === 'queue:sync' && m.playback) w.__srv = { playback: m.playback };
			if (m.type === 'playback:state') w.__srv = { playback: m.state };
		};
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error('the phone-side observer socket never opened'));
		});
		w.__srvWs = ws;
	});
}

interface ServerPlayback {
	currentEntryId: string | null;
	isPlaying: boolean;
}

async function serverPlayback(phone: Page): Promise<ServerPlayback | null> {
	return phone.evaluate(
		() => (window as unknown as { __srv?: { playback: ServerPlayback | null } }).__srv?.playback ?? null
	);
}

interface DrainedRoom {
	phone: Page;
	tv: Page;
	worker: FakeWorker;
	song: SongRow;
	/** Was the TV actually refused autoplay? The PREMISE, read from world/autoplay's own shim rather than
	 *  inferred from the app's reaction, so a broken shim cannot read as a pass. */
	policyHeld: boolean;
	blocked: ScrimReading;
	drained: ScrimReading;
}

/**
 * Drive one room all the way to the drained empty lobby: a singer joins, queues the processed song, the TV
 * loads it and CANNOT start it, then a skip at the last entry empties the room. Returns both readings —
 * before the drain the hint must be up, or nothing after it proves anything.
 */
async function driveToDrainedLobby(world: World): Promise<DrainedRoom> {
	const worker = await startFakeWorker(world);
	const phone = await world.openPhone('Scrim');
	const song = await processToReady(world, phone, SONG);
	await observeServerPlayback(phone);

	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill(SONG);
	await phone.locator(SEL.addTurn).first().click();
	// Back to the queue BEFORE reading rows: the rotation is not rendered in the results view at all.
	await returnHomeFromBrowse(phone);
	// ONE ENTRY, NOTHING BEHIND IT: a ready song added to an idle room is promoted to `playing` by
	// reconcileOnReady, so the entry is the one the strip names and `.qrow` (queued only) is empty.
	await expect(phone.locator(SEL.npStripTitle)).toContainText(SONG);
	await expect(phone.locator(SEL.queueRow)).toHaveCount(0);

	const tv = await world.openTv();
	// THE POLICY IS THE PREMISE: this browser cannot refuse autoplay (world/autoplay.ts carries the measurements),
	// and the latch this probe is about is set by a REFUSED `play()`. Installed AFTER the page exists and taken on
	// a reload, because `openTv` owns the first navigation and an override applied by `evaluate` would race the
	// `play()` the app has already made.
	await requireActivationForPlayback(tv);
	await tv.reload();
	await tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
	const policyHeld = await autoplayIsBlocked(tv);
	// The CORRECT pre-drain state: a song is on stage and the TV cannot start it. The latch is set when the
	// `play()` promise REJECTS, which is after the src lands, so this waits for the hint rather than sleeping
	// as the old driver did — and tolerates its absence, because a timeout here must red the named
	// blocked-state claim with its measured reading instead of aborting the flow.
	await tv
		.locator(SEL.autoplayHint)
		.waitFor({ state: 'attached', timeout: 25_000 })
		.catch(() => {});
	const blocked = await readScrim(tv);

	// The skip at the last entry — the drain, and the second of the two inputs that reach this state. The
	// real transport button, because a `player:command` from an unjoined origin is refused and a synthetic
	// click is not an input.
	await phone.getByRole(SEL.skip.role, { name: SEL.skip.name }).click();
	await expect
		.poll(async () => await serverPlayback(phone), {
			message: 'the SERVER never reported the room drained (currentEntryId null, isPlaying false)'
		})
		.toMatchObject({ currentEntryId: null, isPlaying: false });
	// …and only then the TV, so the lobby being measured is the one the drained server published.
	await tv.locator(SEL.lobby).waitFor({ state: 'attached' });
	await expect(tv.locator(SEL.mediaEl)).toHaveCount(0);

	const drained = await readScrim(tv);
	return { phone, tv, worker, song, policyHeld, blocked, drained };
}

test('the tap-to-start scrim does not outlive the room', async ({ world }) => {
	const room = await driveToDrainedLobby(world);
	try {
		const { blocked, drained } = room;
		// THE PREMISE, FIRST AND SEPARATELY: if the TV was never refused autoplay, every claim below is about a
		// room that was never in the state this probe exists for.
		expect(
			room.policyHeld,
			'the TV was NOT under the no-activation policy, so nothing here is evidence about a blocked TV'
		).toBe(true);
		expect(
			blocked.hint,
			`hint=${blocked.hint} style=${JSON.stringify(blocked.hintStyle)} — without this the rest of the ` +
				`run proves nothing`
		).toBe(true);

		// Four readings off ONE snapshot of the drained lobby, so nothing can shift between them.
		expect(
			drained.lobby && drained.mediaCount === 0,
			`lobby=${drained.lobby} mediaCount=${drained.mediaCount} — the room did not really drain`
		).toBe(true);
		expect(
			drained.card,
			`card=${drained.card} rect=${JSON.stringify(drained.cardRect)} — a missing card would make the ` +
				`reachability claim vacuous`
		).toBe(true);
		expect(
			drained.hint,
			`hint=${drained.hint} style=${JSON.stringify(drained.hintStyle)} — an 82% full-viewport scrim over ` +
				`an empty room, promising to start music with nothing queued`
		).toBe(false);
		expect(
			drained.joinCardReachable,
			`elementFromPoint at ${JSON.stringify(drained.cardRect)} -> "${drained.topAtJoinCard}" — a guest ` +
				`cannot read or use the join card`
		).toBe(true);

		// The state is INDEFINITE, so re-measure after a dwell rather than trusting one frame.
		await new Promise((r) => setTimeout(r, IDLE_DWELL_MS));
		const later = await readScrim(room.tv);
		expect(
			later.hint === false && later.joinCardReachable === true,
			`hint=${later.hint} top="${later.topAtJoinCard}" — the defect was indefinite, so one frame is not enough`
		).toBe(true);
	} finally {
		await room.worker.stop();
	}
});

test('the blocked latch survives the idle window: the hint returns with a song back on stage', async ({ world }) => {
	// GATE THE RENDER, NEVER CLEAR THE LATCH: the block is a property of this TV, so it must come back the
	// moment there is something to start. If this fails the fix threw away a real property of the TV.
	const room = await driveToDrainedLobby(world);
	try {
		expect(
			room.policyHeld,
			'the TV was NOT under the no-activation policy, so a returning hint would prove nothing about a latch'
		).toBe(true);
		expect(room.blocked.hint, 'the hint was never up before the drain, so its RETURN proves nothing').toBe(true);
		expect(
			room.drained.hint,
			'the scrim never cleared, so this spec cannot tell a survived latch from a stuck one'
		).toBe(false);

		// The song is READY by now, so the home row offers the plain add rather than the process-and-queue action.
		await room.phone.locator(SEL.addTurn).first().click();
		await expect(room.tv.locator(SEL.mediaEl)).not.toHaveCount(0, { timeout: 25_000 });
		await expect
			.poll(async () => (await readScrim(room.tv)).hint, {
				message:
					'the tap-to-start hint did not come back with a song on stage — the blocked latch was thrown ' +
					'away with the scrim'
			})
			.toBe(true);
	} finally {
		await room.worker.stop();
	}
});
