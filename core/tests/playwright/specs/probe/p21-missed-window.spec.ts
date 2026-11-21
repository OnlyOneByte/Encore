// P21 — THE MISSED PRELOAD WINDOW. When song 2's pre-warm is not ready at song 1's end, the TV loads song 2 into the
// visible slot right away, one server frame AHEAD of the server. Two things must hold in that frame:
//   · a song 2 that will not play still advances the room. Its error sends a second `ended`, which must name song 2 —
//     the entry its slot held. Stamped with the page's `current` (still song 1) the server drops it as stale and the
//     room parks on a dead song forever.
//   · the song-intro card comes up with song 2's audio, not a round trip later when the server's frame lands.
//
// Loopback hides both: the server's frame beats song 2. So the TV's outgoing `ended` is held for a simulated round trip.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, returnHomeFromBrowse } from '../../world/actors';
import {
	armMediaLog,
	processTrack,
	readMediaLog,
	queueReadyTrack,
	sendPlayerCommand,
	serverPlayback,
	tapStage,
	TRACKS,
	type ReadyMedia
} from './audio-probe-support';
import type { Page, Route } from '@playwright/test';
import type { World } from '../../world/fixtures';

/** Simulated TV→server round trips, in ms. 0 is loopback; a real TV on Wi-Fi sits in the tens to low hundreds. */
const ROUND_TRIPS_MS = [0, 20, 50, 150];

const matcherFor = (m: ReadyMedia) => (src: string) =>
	src.includes(m.id) || (!!m.instrumentalRef && src.includes(m.instrumentalRef));

/** Delay every outgoing `ended` telemetry frame by `ms`, so the server learns of the end late. Logs each, and media errors and seeks. */
async function holdEnded(tv: Page, ms: number) {
	await tv.evaluate((hold) => {
		type Log = { ev: string; src: string; t: number }[];
		const log = () => (window as unknown as { probeMediaLog?: Log }).probeMediaLog;
		const send = WebSocket.prototype.send;
		WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
			if (typeof data === 'string' && data.includes('"status":"ended"')) {
				log()?.push({ ev: 'ws-ended', src: `entryId=${JSON.parse(data).entryId}`, t: performance.now() });
				setTimeout(() => send.call(this, data), hold);
				return;
			}
			const ws = this as WebSocket & { probeLogged?: boolean };
			if (!ws.probeLogged) {
				ws.probeLogged = true;
				// The server's frames, so a failure's timeline shows which one moved the stage.
				ws.addEventListener('message', (m) => {
					let f: { type?: string; rev?: number; current?: { id: string }; state?: { currentEntryId?: string } };
					try {
						f = JSON.parse(String(m.data));
					} catch {
						return;
					}
					if (f.type === 'nowplaying:changed' || f.type === 'playback:state')
						log()?.push({
							ev: `ws-${f.type}`,
							src: `entryId=${f.current?.id ?? f.state?.currentEntryId}${f.rev === undefined ? '' : ` rev=${f.rev}`}`,
							t: performance.now()
						});
				});
			}
			return send.call(this, data);
		};
		for (const ev of ['error', 'seeking']) {
			document.addEventListener(
				ev,
				(e) => {
					const el = e.target;
					if (el instanceof HTMLMediaElement)
						log()?.push({
							ev,
							src: `${el.getAttribute('src') ?? ''} @${el.currentTime.toFixed(2)}`,
							t: performance.now()
						});
				},
				true
			);
		}
	}, ms);
}

/**
 * Alice's song 1 then Bob's song 2, with every TV request for song 2 answered by `song2Route` (none: the warmed swap).
 * Returns once song 1 ended.
 */
async function playUntilSong1Ends(
	world: World,
	holdMs: number,
	song2Route?: (r: Route) => Promise<void>,
	whileSong1Plays?: (alice: Page) => Promise<void>
) {
	const alice = await world.openPhone('Alice');
	const bob = await world.openPhone('Bob');
	await openBrowseFromHome(alice);
	await openBrowseFromHome(bob);
	const song1 = await processTrack(alice, world.baseURL, TRACKS.caroline);
	const song2 = await processTrack(bob, world.baseURL, TRACKS.believin);
	const is1 = matcherFor(song1);
	const is2 = matcherFor(song2);
	const tv = await world.openTv();
	if (song2Route) await tv.route((u) => is2(u.pathname), song2Route);
	await expect(tv.locator(SEL.tvRoot)).toBeAttached();
	await tapStage(tv);
	await armMediaLog(tv);
	await holdEnded(tv, holdMs);
	await queueReadyTrack(alice, TRACKS.caroline);
	await returnHomeFromBrowse(alice);
	await queueReadyTrack(bob, TRACKS.believin);
	await returnHomeFromBrowse(bob);
	await whileSong1Plays?.(alice);
	await expect
		.poll(async () => (await readMediaLog(tv)).some((e) => e.ev === 'ended' && is1(e.src)), {
			timeout: 40_000,
			intervals: [20]
		})
		.toBe(true);
	const timeline = async () =>
		(await readMediaLog(tv)).map((e) => {
			const at = e.src.match(/ @[\d.]+$/)?.[0] ?? ''; // the element's playhead, on an error or a seek
			return `${Math.round(e.t)} ${e.ev} ${is1(e.src) ? 'S1' : is2(e.src) ? 'S2' : e.src}${at}`;
		});
	return { tv, alice, is1, is2, timeline };
}

for (const holdMs of ROUND_TRIPS_MS) {
	test(`P21 · a next song that will not decode does not stall the room (${holdMs}ms round trip)`, async ({ world }) => {
		const worker = await startFakeWorker(world);
		try {
			const { timeline } = await playUntilSong1Ends(world, holdMs, (r) =>
				r.fulfill({ status: 200, contentType: 'audio/wav', body: 'not a wav file at all' })
			);
			const at = Date.now();
			const seen: string[] = [];
			// Song 2 is current on the server once song 1's `ended` lands; it must then be skipped as dead, emptying the queue.
			await expect
				.poll(
					async () => {
						const cur = String((await serverPlayback(world.baseURL)).state.currentEntryId);
						if (!seen.includes(cur)) seen.push(cur);
						return cur === 'null';
					},
					{ timeout: 20_000, intervals: [250] }
				)
				.toBe(true)
				.catch(async (err) => {
					const t = await timeline();
					console.log(
						`P21 ${holdMs}ms: stalled ${Date.now() - at}ms; server current: ${seen.join(' -> ')}\n  ${t.join('\n  ')}`
					);
					throw err;
				});
			console.log(
				`P21 ${holdMs}ms: advanced past the dead song in ${Date.now() - at}ms; server current: ${seen.join(' -> ')}`
			);
		} finally {
			await worker.stop();
		}
	});
}

test("P21 · a missed preload raises song 2's card with its audio, not a round trip later", async ({ world }) => {
	const HOLD_MS = 1500;
	const worker = await startFakeWorker(world);
	try {
		// Song 2's bytes are withheld until song 1 has ended, so its pre-warm can never be ready: the missed window.
		let release!: () => void;
		const song1Ended = new Promise<void>((r) => (release = r));
		const { tv, timeline } = await playUntilSong1Ends(world, HOLD_MS, async (r) => {
			await song1Ended;
			await r.continue();
		});
		release();
		const before = (await serverPlayback(world.baseURL)).state.currentEntryId;
		const card = tv.locator(SEL.stateNext);
		// Well inside the held `ended`, so only the TV's own handling can have raised it.
		await expect(
			card,
			`no card within ${HOLD_MS - 500}ms of song 1's end:\n  ${(await timeline()).join('\n  ')}`
		).toBeVisible({
			timeout: HOLD_MS - 500
		});
		await expect(card.locator(SEL.upName)).toHaveText('Bob');
		const after = (await serverPlayback(world.baseURL)).state.currentEntryId;
		expect(after, "the server's frame had already landed, so this run does not prove the card was the TV's own").toBe(
			before
		);
	} finally {
		await worker.stop();
	}
});

// #1001. Any phone command (a background change, a guide drag, a reorder) makes the server re-send its OLD pair, and the
// old song's playback state, while it has not yet processed the TV's `ended`. The TV has moved past that entry, so the
// frame must neither reload song 1 nor seek song 2. The server's own advance frame then lands: song 2 at 0 is the
// start the TV already made, not a restart, so it must not seek song 2 back by a round trip either.
for (const window of ['missed', 'warmed'] as const) {
	for (const holdMs of [20, 50, 150]) {
		test(`P21 · a stale pair in the ${window} window neither rewinds nor seeks song 2 (${holdMs}ms round trip)`, async ({
			world
		}) => {
			const worker = await startFakeWorker(world);
			try {
				let release!: () => void;
				const song1Ended = new Promise<void>((r) => (release = r));
				const withheld = async (r: Route) => {
					await song1Ended;
					await r.continue();
				};
				const { tv, alice, is1, is2, timeline } = await playUntilSong1Ends(
					world,
					holdMs,
					window === 'missed' ? withheld : undefined,
					// Opens the phone's command socket now, so the command after song 1's end goes out at once.
					(a) => sendPlayerCommand(a, { cmd: 'background', style: null })
				);
				release();
				await sendPlayerCommand(alice, { cmd: 'background', style: null });
				await tv.waitForTimeout(holdMs + 2500);
				const log = await readMediaLog(tv);
				const endA = log.find((e) => e.ev === 'ended' && is1(e.src))!;
				const startB = log.find((e) => e.ev === 'playing' && is2(e.src) && e.t > endA.t);
				const t = (await timeline()).join('\n  ');
				expect(startB, `song 2 never started:\n  ${t}`).toBeDefined();
				const after = (e: { t: number }, from: { t: number }) => e.t > from.t;
				expect(
					log.filter((e) => e.ev === 'playing' && is1(e.src) && after(e, endA)),
					`song 1 replayed:\n  ${t}`
				).toEqual([]);
				expect(
					log.filter((e) => e.ev === 'emptied' && is1(e.src) && after(e, endA)),
					`a slot reloaded song 1:\n  ${t}`
				).toEqual([]);
				expect(
					log.filter((e) => e.ev === 'emptied' && after(e, startB!)),
					`a slot reloaded after song 2 started:\n  ${t}`
				).toEqual([]);
				// A seek of song 2 is judged by the server frame just before it. Song 1's state (stale) or the server's advance
				// onto song 2 (its first `rev`, and any repeat of it) must not move song 2. A later frame is the phone's command
				// landing AFTER the advance: it carries the server's song-2 position, still 0 before any song-2 telemetry,
				// and restarting from there is main's behaviour for any command in a song's first moments, not this window's.
				const frames = (e: { ev: string }) => e.ev === 'ws-playback:state';
				const ev = (e: { ev: string }) => e.ev as string;
				const s1Entry = log.find((e) => ev(e) === 'ws-ended' && after(e, endA))?.src;
				const advanceRev = log
					.find((e) => frames(e) && after(e, endA) && !e.src.startsWith(`${s1Entry} `))
					?.src.split(' ')[1];
				const byStaleOrAdvance = log.filter((e) => {
					if ((e.ev as string) !== 'seeking' || !is2(e.src) || !after(e, startB!)) return false;
					const cause = log.filter((f) => frames(f) && f.t <= e.t).at(-1)?.src ?? '';
					return cause.startsWith(`${s1Entry} `) || cause.endsWith(` ${advanceRev}`);
				});
				expect(byStaleOrAdvance, `song 2 was seeked by a stale or advance frame:\n  ${t}`).toEqual([]);
				// Non-vacuity at the longest round trip: the command's stale frame did land inside the window.
				if (holdMs === 150)
					expect(
						log.some((e) => frames(e) && after(e, endA) && e.src.startsWith(`${s1Entry} `)),
						`no stale frame landed inside the window, so this run proved nothing:\n  ${t}`
					).toBe(true);
			} finally {
				await worker.stop();
			}
		});
	}
}
