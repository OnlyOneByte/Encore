// Does a mid-song TV RELOAD resume at the room position, and leave the server's position alone? On a cold
// mount the room position rides `playback:state`, which the server sends BEFORE the `nowplaying:changed` that
// mounts the <audio>, so a correct app holds it and applies it on `canplay`. A fresh master near 0 while the
// room is at ~6s is the defect; the corroborating half is that the server position must not FALL after the
// reload (the backwards-telemetry drag).
//
// ONE test, two assertions: both read the SAME pair of samples (before the reload, after it), and a second
// pass would be a second reload with its own timing. Splitting them would also split the sequence they only
// make sense inside.
//
// THE GESTURE. p15 ran with the autoplay policy relaxed, because "a reload has to resume a MOVING playhead".
// playwright.config.ts refuses that grant on purpose — a television grants no gesture, so a policy-relaxed
// browser is not the environment the product ships into — so the authorisation is bought the way a real room
// buys it: one real tap in the TV's own document, which TvPlayer's always-armed pointerdown listener turns
// into playback. A RELOAD MINTS A NEW DOCUMENT, so the tap is paid TWICE, once per document. That is the real
// user path in a browser that blocks autoplay, and it changes nothing the assertions measure.
//
// THE ROOM CLOCK IS RE-ASKED, NOT LISTENED FOR. p15 opened a probe socket, sent ONE `hello`, and read
// whatever the last `playback:state` had carried. But `Store.setPosition` deliberately does not bump rev and
// deliberately does not broadcast (src/lib/server/state/store.ts:121) — the 4Hz telemetry stream would
// otherwise force a resync storm — so between a song starting and a player command there is NO frame carrying
// an advanced position, and that probe could only ever have read the position at the last broadcast: 0 for a
// song that had just started. The claim is about the room's position AT THE MOMENT OF READING, so this port
// re-requests the snapshot per read (`hello` → `playback:state`, answered to that socket alone). The
// comparison, and both tolerances, are p15's own.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import { WebSocket } from 'ws';
import type { Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

/** Past SEEK_JUMP_SEC (1.5s) by a clear margin, so a resume vs a restart-from-0 is unambiguous. */
const PLAYHEAD_FLOOR_SEC = 3;
/** Below this the element is holding a buffer, not decoding, and a resume off it would prove nothing. */
const DECODING_BYTES = 32768;
/** The room keeps ADVANCING during the reload, so the comparison is against the CURRENT room position and it
 *  is generous: reload + decode latency is a second or two, where the defect is the whole song away. */
const RESUME_TOL = 2.5;
/** The room position only ever advances, so a fall below the pre-reload value is the backwards drag. */
const SERVER_DRAG_TOL = 0.5;

interface Readout {
	t: number;
	src: string;
	bytes: number;
	paused: boolean;
}

/** What the TV is actually playing. Scoped to `/media/`, so the pre-warm slot's empty element is skipped. */
async function readMaster(tv: Page): Promise<Readout | null> {
	return tv.evaluate(() => {
		const els = [...document.querySelectorAll<HTMLMediaElement>('audio')];
		const m = els.find((e) => e.currentSrc && e.currentSrc.includes('/media/'));
		return m
			? {
					t: m.currentTime,
					src: m.currentSrc,
					// Chromium-only and deprecated, and load-bearing anyway: "an element exists" and "sound is
					// coming out of it" are different claims, and only this one distinguishes them.
					bytes: (m as HTMLMediaElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount ?? 0,
					paused: m.paused
				}
			: null;
	});
}

interface RoomClock {
	/** The room's authoritative position, asked for fresh. */
	position(): Promise<number>;
	close(): void;
}

/**
 * A socket that can ASK for the room's playback snapshot. Playback state is exposed only over the WebSocket,
 * and `hello` is answered to the asking socket alone (server.ts:212), so this is the whole instrument.
 *
 * `ws`, not the global WebSocket: the handshake needs the singer's session COOKIE, and Node's built-in
 * WebSocket silently ignores a headers option — see world/presence.ts for the same reason.
 */
async function openRoomClock(baseURL: string, cookie: string): Promise<RoomClock> {
	const ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws?role=phone`, { headers: { Cookie: cookie } });
	await new Promise<void>((resolve, reject) => {
		ws.once('open', () => resolve());
		ws.once('error', (err: Error) => reject(new Error(`room-clock socket refused: ${err.message}`)));
	});
	return {
		position: () =>
			new Promise<number>((resolve, reject) => {
				const onMessage = (raw: Buffer | string) => {
					let msg: { type?: string; state?: { positionSec?: unknown } };
					try {
						msg = JSON.parse(String(raw));
					} catch {
						return;
					}
					if (msg.type !== 'playback:state' || typeof msg.state?.positionSec !== 'number') return;
					clearTimeout(timer);
					ws.off('message', onMessage);
					resolve(msg.state.positionSec);
				};
				const timer = setTimeout(() => {
					ws.off('message', onMessage);
					reject(new Error('the room answered no playback:state within 5s of a hello'));
				}, 5_000);
				ws.on('message', onMessage);
				ws.send(JSON.stringify({ type: 'hello' }));
			}),
		close: () => ws.close()
	};
}

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
 * Process one local library song and resolve when it is READY with an instrumental to play. The requests go
 * through the PAGE's context, so they carry that phone's singer cookie — `/api/process` refuses an anonymous
 * caller.
 *
 * `world.awaitDemoTrack` FIRST, because the library scan is a detached boot pass: /health answers about four
 * seconds before the index is populated, so a single search taken right after boot can answer from an empty
 * index and nothing re-runs it.
 */
async function processToReady(world: World, page: Page, query: string): Promise<SongRow> {
	const track = await world.awaitDemoTrack(query);
	const search = async (): Promise<SearchBody> =>
		(await page.request.get(`/api/search?q=${encodeURIComponent(query)}`).then((r) => r.json())) as SearchBody;
	const found = await search();
	const row = [...found.ready, ...found.processing, ...found.results].find((x) => x.id === track.id);
	if (!row) throw new Error(`the indexed track ${track.id} did not come back from ?q=${query}`);
	const res = await page.request.post('/api/process', { data: { mediaId: row.id } });
	if (!res.ok()) throw new Error(`/api/process refused "${query}": ${res.status()} ${await res.text()}`);
	await expect
		.poll(async () => (await search()).ready.some((r) => r.id === row.id && !!r.instrumentalRef), {
			timeout: 60_000,
			message: `"${row.title}" never reached ready with an instrumental ref`
		})
		.toBe(true);
	return row;
}

test('a mid-song reload resumes at the room position without dragging the server backwards', async ({ world }) => {
	const worker = await startFakeWorker(world);
	let clock: RoomClock | null = null;
	try {
		const phone = await world.openPhone('P15');
		const song = await processToReady(world, phone, 'caroline');

		// Queued through the REAL row action, where p15 minted a raw `queue:command` on a probe socket. The
		// subject is the reload, not how the turn was taken, and a real tap cannot desync from the UI.
		await openBrowseFromHome(phone);
		await phone.locator(SEL.search).fill('caroline');
		await phone.locator(SEL.addTurn).first().click();

		const cookies = await phone.context().cookies();
		clock = await openRoomClock(world.baseURL, cookies.map((c) => `${c.name}=${c.value}`).join('; '));

		const tv = await world.openTv();
		await tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
		await tv.mouse.click(960, 540);

		// BOTH clocks past the floor, not just the element's. p15 waited only on the TV's playhead and then
		// bailed if the room was not also past 3s — but the room is advanced by the TV's own ~4Hz telemetry, so
		// it lags the element by up to a frame, and that gate lost the race by fractions of a second. The
		// CONDITION is p15's own (a resume is only unambiguous once both are clear of SEEK_JUMP_SEC by a
		// margin); it is waited for here instead of sampled once.
		await expect
			.poll(
				async () => {
					const master = await readMaster(tv);
					if (!master) return 0;
					return Math.min(master.t, await clock!.position());
				},
				{
					timeout: 60_000,
					message:
						`"${song.title}" never reached a playhead AND a room position past ${PLAYHEAD_FLOOR_SEC}s — ` +
						`nothing to resume`
				}
			)
			.toBeGreaterThan(PLAYHEAD_FLOOR_SEC);

		const before = await readMaster(tv);
		if (!before) throw new Error('the TV lost its master element between the playhead wait and the reading');
		const roomBefore = await clock.position();
		// Both are PRECONDITIONS on the environment, not claims about the app: p15 bailed with exit 2 on either,
		// and this suite throws instead of skipping — a resume off a silent element, or off a room that never
		// advanced, would prove nothing whichever way it came out.
		if (before.bytes <= DECODING_BYTES) {
			throw new Error(
				`the TV is not really decoding (${before.bytes}B ≤ ${DECODING_BYTES}B) — a resume would prove ` +
					`nothing.\n\n${worker.log()}\n${world.core.log()}`
			);
		}
		if (!Number.isFinite(roomBefore) || roomBefore <= PLAYHEAD_FLOOR_SEC) {
			throw new Error(
				`the server position is not past ${PLAYHEAD_FLOOR_SEC}s (${roomBefore}) — no resume to test.\n\n` +
					world.core.log()
			);
		}

		// THE REPRO.
		await tv.reload();
		// The app hydrates and THEN opens its socket, so the document being loaded says nothing about whether
		// the room state has arrived. Wait for the socket, then pay the gesture this new document needs.
		await tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
		await tv.mouse.click(960, 540);

		await expect
			.poll(async () => (await readMaster(tv))?.bytes ?? 0, {
				timeout: 30_000,
				message: 'the reloaded TV never mounted a decoding master — cannot judge the resume'
			})
			.toBeGreaterThan(DECODING_BYTES);

		const after = await readMaster(tv);
		if (!after) throw new Error('the reloaded TV lost its master element between the decode wait and the reading');
		const roomAfter = await clock.position();

		const where =
			`before: TV t=${before.t.toFixed(2)}s decoded=${before.bytes}B, room=${roomBefore.toFixed(2)}s | ` +
			`after: TV t=${after.t.toFixed(2)}s decoded=${after.bytes}B, room=${roomAfter.toFixed(2)}s`;

		expect(
			Math.abs(after.t - roomAfter),
			`the reloaded master did NOT resume — a cold-mounted TV restarted the song from ~0 instead of ` +
				`resuming. ${where}`
		).toBeLessThanOrEqual(RESUME_TOL);
		expect(
			roomBefore - roomAfter,
			`the reloaded TV dragged the server position BACKWARDS — the fresh master's telemetry overwrote the ` +
				`room position from 0. ${where}`
		).toBeLessThanOrEqual(SERVER_DRAG_TOL);
	} finally {
		clock?.close();
		await worker.stop();
	}
});
