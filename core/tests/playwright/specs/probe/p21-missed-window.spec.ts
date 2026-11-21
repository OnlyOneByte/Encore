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

/** Delay every outgoing `ended` telemetry frame by `ms`, so the server learns of the end late. Logs each, and media errors. */
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
			return send.call(this, data);
		};
		document.addEventListener(
			'error',
			(e) => {
				const el = e.target;
				if (el instanceof HTMLMediaElement)
					log()?.push({ ev: 'error', src: el.getAttribute('src') ?? '', t: performance.now() });
			},
			true
		);
	}, ms);
}

/** Alice's song 1 then Bob's song 2, with every TV request for song 2 answered by `song2Route`. Returns once song 1 ended. */
async function playUntilSong1Ends(world: World, holdMs: number, song2Route: (r: Route) => Promise<void>) {
	const alice = await world.openPhone('Alice');
	const bob = await world.openPhone('Bob');
	await openBrowseFromHome(alice);
	await openBrowseFromHome(bob);
	const song1 = await processTrack(alice, world.baseURL, TRACKS.caroline);
	const song2 = await processTrack(bob, world.baseURL, TRACKS.believin);
	const is1 = matcherFor(song1);
	const is2 = matcherFor(song2);
	const tv = await world.openTv();
	await tv.route((u) => is2(u.pathname), song2Route);
	await expect(tv.locator(SEL.tvRoot)).toBeAttached();
	await tapStage(tv);
	await armMediaLog(tv);
	await holdEnded(tv, holdMs);
	await queueReadyTrack(alice, TRACKS.caroline);
	await returnHomeFromBrowse(alice);
	await queueReadyTrack(bob, TRACKS.believin);
	await returnHomeFromBrowse(bob);
	await expect
		.poll(async () => (await readMediaLog(tv)).some((e) => e.ev === 'ended' && is1(e.src)), {
			timeout: 40_000,
			intervals: [50]
		})
		.toBe(true);
	const timeline = async () =>
		(await readMediaLog(tv)).map((e) => `${Math.round(e.t)} ${e.ev} ${is1(e.src) ? 'S1' : is2(e.src) ? 'S2' : e.src}`);
	return { tv, timeline };
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
