// P4 — TRANSPORT, SEEK AND POSITION TELEMETRY. Each arm keeps its `T<n> ·` name from the old probe, so a
// failure here still matches the arm it was filed under.
//
// THE PHONE BAR IS ONLY AUTHORITATIVE AT PAUSE. `displayPos` interpolates from the last playback:state anchor
// plus a wall clock, so during PLAY it climbs perfectly even while telemetry is dropping. Every phone-bar
// reading below is therefore taken after an `isPlaying:false` broadcast.
//
// THE MASTER IS SCOPED TO `.slot.visible audio` (audio-probe-support.ts): the hidden pre-warm slot carries its
// own PAUSED <audio> at currentTime 0, so a looser query reads a playing stage as silent.
//
// See docs/E2E.md#proving-audio — every arm is anchored to the decoded byte counter, never to `paused` alone.
//
// Ported from tests/e2e/probes/p4-transport.mjs. EVERY ARM HERE IS A TRANSPORT ARM — pause, resume, seek,
// restart, skip — so none of them lost its subject when the now-playing sheet was deleted; the sheet only ever
// appeared in this header. What moved is WHERE the controls are: all three live in the docked strip
// (NowPlayingStrip.svelte), which has no open state, so none of them needs a gesture to reach. `play/pause` as an
// aria-label is still retired in world/selectors.ts, for the original reason — it resolved against nothing while
// reading as though the flow worked.
//
// THE PHONE'S SPELLED CLOCK MOVED ROUTES, which is the one thing here that is more than a rename. The strip
// carries an `aria-hidden` progress hairline and no numbers; the elapsed and remaining readouts live on /queue's
// now-playing card. `phoneElapsed` below therefore reads a surface its caller has to navigate to first.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue } from '../../world/actors';
import {
	awaitMaster,
	readMaster,
	readStage,
	sendPlayerCommand,
	serverPlayback,
	singTrack,
	tapStage,
	TRACKS,
	type MediaRow,
	type ReadyMedia
} from './audio-probe-support';
import type { Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

/** The rendered elapsed side rounds DOWN, so "0:04" means at least 4s and less than 5s. */
function parseClock(text: string | null): number | null {
	if (!text) return null;
	const parts = text.split(':').map(Number);
	if (parts.some((p) => !Number.isFinite(p))) return null;
	if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
	if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
	return null;
}

/**
 * The elapsed clock on /queue's now-playing card. The old probe also captured the fill's scaleX; nothing asserted
 * on it, and the strip's progress is an `aria-hidden` hairline with no readout, so only the clock is read.
 *
 * THE CALLER MUST BE ON /queue. This used to read `.seekrow .time` in the sheet's body, which was reachable from
 * any phone surface; the phone spells its clock in exactly one place now, so this is a route change and not a
 * selector swap. It stays a bare read rather than navigating itself because its caller polls it.
 */
async function phoneElapsed(phone: Page): Promise<{ text: string | null; seconds: number | null }> {
	const text = await phone.locator(SEL.queueElapsed).first().textContent();
	return { text, seconds: parseClock(text) };
}

/**
 * Let the playhead reach `seconds` before acting on it. A PRECONDITION, not a dwell: "pause did not seek to 0"
 * and "the phone's clock did not reset to 0:00" are only distinguishable from a fresh start once the song has
 * genuinely got somewhere, and the old probe had that for free because it measured for 2.5s first.
 */
async function awaitPlayhead(tv: Page, seconds: number): Promise<void> {
	await expect
		.poll(async () => (await readMaster(tv))?.currentTime ?? 0, {
			timeout: 15_000,
			message: `the playhead never reached ${seconds}s, so a held position could not be told from a reset one`
		})
		.toBeGreaterThan(seconds);
}

const transport = {
	/** The strip's only FILLED control, and the app's only play/pause. Where `.disc` was artwork, a progress ring
	 *  and a glyph in one element, this is an icon button with an `--accent` fill — the fill is there because
	 *  play/pause is the one control whose state a resting fill encodes — and the progress is a separate
	 *  `aria-hidden` hairline across the top of the strip. */
	playPause: (page: Page) => page.locator(SEL.npPlayPause),
	restart: (page: Page) => page.getByRole(SEL.restart.role, { name: SEL.restart.name }),
	skip: (page: Page) => page.getByRole(SEL.skip.role, { name: SEL.skip.name })
};

interface Stage {
	worker: Awaited<ReturnType<typeof startFakeWorker>>;
	phones: Page[];
	tv: Page;
	media: ReadyMedia[];
	/** The master as it was when the stage settled into playing. */
	master: MediaRow;
}

/**
 * A room with `tracks` queued from `singers.length` phones and a TV that is really playing.
 *
 * THREE TRACKS where a test needs them: the transport target, the skip-to-next target, and headroom so the
 * out-of-bounds seek can consume one without emptying the queue before the last-song skip.
 */
async function stage(
	world: World,
	tracks: { title: string; q: string }[] = [TRACKS.caroline],
	singers = 1
): Promise<Stage> {
	const worker = await startFakeWorker(world);
	const phones: Page[] = [];
	for (let i = 0; i < singers; i++) phones.push(await world.openPhone(`P4${'AB'[i] ?? i}${i}`));
	for (const phone of phones) await openBrowseFromHome(phone);
	const media: ReadyMedia[] = [];
	// Round-robin, so the credit-the-authenticated-singer path is exercised from more than one session.
	for (let i = 0; i < tracks.length; i++) {
		media.push(await singTrack(phones[i % phones.length]!, world.baseURL, tracks[i]!));
	}
	const tv = await world.openTv();
	await awaitMaster(tv);
	// ONE REAL TAP. Not a relaxed autoplay policy: see audio-probe-support.ts#tapStage and p13, whose whole
	// subject is what a television does with no gesture at all.
	await tapStage(tv);
	// Every arm below acts on a PLAYING song, so the stage is not settled until the decoder is running.
	let master = await awaitMaster(tv);
	await expect
		.poll(
			async () => {
				const m = await readMaster(tv);
				if (m) master = m;
				return m ? !m.paused && m.currentTime > 0.2 : false;
			},
			{ timeout: 20_000, message: 'the TV never started playing, so there is no transport to drive' }
		)
		.toBe(true);
	return { worker, phones, tv, media, master };
}

test('T0 · the TV mounts the instrumental and really plays it', async ({ world }) => {
	const { worker, tv } = await stage(world);
	try {
		const m0 = await awaitMaster(tv);
		expect(m0.src, `src=${m0.src}`).toContain('instrumental');
		// A MEASUREMENT INTERVAL, not a workaround: both readings below are rates.
		await tv.waitForTimeout(2500);
		const m1 = await awaitMaster(tv);
		const dDecoded = (m1.decoded ?? 0) - (m0.decoded ?? 0);
		expect(
			dDecoded,
			`audio must be decoding for the transport to act on a playing song: decoded ${m0.decoded} → ` +
				`${m1.decoded} (+${dDecoded}) over 2.5s`
		).toBeGreaterThan(0);
		expect(
			m1.currentTime - m0.currentTime,
			`the playhead must advance against the wall clock: ${m0.currentTime.toFixed(2)} → ${m1.currentTime.toFixed(2)}`
		).toBeGreaterThan(1.0);
	} finally {
		await worker.stop();
	}
});

test('T1a/T1b/T3 · pause stops the master, holds the playhead, and the server says so', async ({ world }) => {
	const { worker, phones, tv } = await stage(world);
	const phone = phones[0]!;
	try {
		await awaitPlayhead(tv, 1.5);
		const beforePause = await awaitMaster(tv);
		await transport.playPause(phone).click();
		await tv.waitForTimeout(800);
		const afterPause = await awaitMaster(tv);
		expect(
			afterPause.paused,
			`T1a: paused=${afterPause.paused}, currentTime=${afterPause.currentTime.toFixed(2)}`
		).toBe(true);
		// T1b: a jump to 0 is the reload class of bug.
		expect(afterPause.currentTime, `T1b: after=${afterPause.currentTime.toFixed(2)}`).toBeGreaterThan(0.5);
		expect(
			Math.abs(afterPause.currentTime - beforePause.currentTime),
			`T1b: before=${beforePause.currentTime.toFixed(2)}, after=${afterPause.currentTime.toFixed(2)}`
		).toBeLessThan(2.5);

		// T3 · `pause` broadcasts playback:state with the CURRENT positionSec, so a server whose telemetry
		// frames were dropped would broadcast 0. Read over a raw socket, which needs no joined singer.
		const srv = await serverPlayback(world.baseURL);
		expect(
			srv.state.positionSec,
			`T3a: server.positionSec=${srv.state.positionSec}, tv.currentTime=${afterPause.currentTime.toFixed(2)}`
		).toBeGreaterThanOrEqual(1);
		expect(
			Math.abs(srv.state.positionSec - afterPause.currentTime),
			`T3a: server.positionSec=${srv.state.positionSec}, tv.currentTime=${afterPause.currentTime.toFixed(2)}`
		).toBeLessThan(3);
		expect(srv.state.isPlaying, `T3b: server.isPlaying=${srv.state.isPlaying}`).toBe(false);
	} finally {
		await worker.stop();
	}
});

test('T4 · both phones anchor their progress to the same paused position', async ({ world }) => {
	// TWO phones, because they derive from the SAME broadcast: a disagreement is a client anchoring locally.
	const { worker, phones, tv } = await stage(world, [TRACKS.caroline], 2);
	const [phone1, phone2] = phones as [Page, Page];
	try {
		await awaitPlayhead(tv, 1.5);
		await transport.playPause(phone1).click();
		const afterPause = await awaitMaster(tv);
		const srv = await serverPlayback(world.baseURL);
		// ONTO /queue FIRST, both of them: the elapsed readout is spelled on the now-playing card and nowhere else
		// on the phone. The transport that paused the room is in the dock, which is why the click above did not have
		// to happen here.
		for (const phone of phones) await openQueue(phone);
		// Waits for the pause broadcast to have REACHED both clients, rather than sleeping on a guess: the
		// reading is only authoritative once each phone has re-anchored.
		for (const [i, phone] of phones.entries()) {
			await expect
				.poll(async () => (await phoneElapsed(phone)).seconds ?? -1, {
					timeout: 10_000,
					message:
						`T4${i === 0 ? 'a' : 'b'}: phone${i + 1}'s progress bar reset to 0 on pause. ` +
						`server=${srv.state.positionSec}s, tv.currentTime=${afterPause.currentTime.toFixed(2)}`
				})
				.toBeGreaterThanOrEqual(1);
		}
		const p1 = await phoneElapsed(phone1);
		const p2 = await phoneElapsed(phone2);
		expect(
			Math.abs((p1.seconds ?? -1) - (p2.seconds ?? -99)),
			`T4c: both phones must show the same elapsed reading — phone1="${p1.text}" phone2="${p2.text}"`
		).toBeLessThanOrEqual(1);
	} finally {
		await worker.stop();
	}
});

test('T1c/T1d · resume picks up where the pause left off', async ({ world }) => {
	const { worker, phones, tv } = await stage(world);
	const phone = phones[0]!;
	try {
		await transport.playPause(phone).click();
		await tv.waitForTimeout(800);
		const afterPause = await awaitMaster(tv);
		expect(afterPause.paused, 'the pause must land before the resume can be measured').toBe(true);

		await transport.playPause(phone).click();
		await tv.waitForTimeout(1600);
		const afterResume = await awaitMaster(tv);
		expect(afterResume.paused, `T1c: paused=${afterResume.paused}`).toBe(false);
		expect(
			(afterResume.decoded ?? 0) - (afterPause.decoded ?? 0),
			`T1c: the decoder must run again — decoded ${afterPause.decoded} → ${afterResume.decoded}`
		).toBeGreaterThan(0);
		expect(
			afterResume.currentTime,
			`T1d: paused at ${afterPause.currentTime.toFixed(2)}, resumed at ${afterResume.currentTime.toFixed(2)}`
		).toBeGreaterThanOrEqual(afterPause.currentTime - 0.3);
	} finally {
		await worker.stop();
	}
});

test('T2a/T2b · a seek lands on the target and playback continues from there', async ({ world }) => {
	const { worker, phones, tv } = await stage(world);
	const phone = phones[0]!;
	try {
		// NO SEEK CONTROL EXISTS on the phone, so the command goes over a raw `player:command` — the same server
		// path a control would use, plus the TV's jump-when-delta>1.5s handler.
		const seekTarget = 4;
		await sendPlayerCommand(phone, { cmd: 'seek', positionSec: seekTarget });
		// The TV effect needs a >1.5s delta and re-runs on the seekSec change; let the WS frame and a rAF land.
		await tv.waitForTimeout(400);
		const afterSeek = await awaitMaster(tv);
		expect(
			Math.abs(afterSeek.currentTime - seekTarget),
			`T2a: currentTime=${afterSeek.currentTime.toFixed(2)}, target=${seekTarget}`
		).toBeLessThan(3);

		await tv.waitForTimeout(2000);
		const afterSeekPlay = await awaitMaster(tv);
		expect(
			(afterSeekPlay.decoded ?? 0) - (afterSeek.decoded ?? 0),
			`T2b: decoding must continue past the seek — decoded ${afterSeek.decoded} → ${afterSeekPlay.decoded}`
		).toBeGreaterThan(0);
		expect(
			afterSeekPlay.currentTime - afterSeek.currentTime,
			`T2b: currentTime ${afterSeek.currentTime.toFixed(2)} → ${afterSeekPlay.currentTime.toFixed(2)}`
		).toBeGreaterThan(1.0);
	} finally {
		await worker.stop();
	}
});

test('T2c · /media serves a mid-file 206, which is what makes seeking work at all', async ({ world }) => {
	// A MID-FILE SLICE is what a seek must fetch; `bytes=0-1` is the WebKit probe and would pass against a
	// route with no Range implementation at all. No browser is involved — the claim is about the route.
	const worker = await startFakeWorker(world);
	const phone = await world.openPhone('P4Range');
	await openBrowseFromHome(phone);
	try {
		const media = await singTrack(phone, world.baseURL, TRACKS.caroline);
		const res = await fetch(`${world.baseURL}/media/${media.instrumentalRef}`, {
			headers: { Range: 'bytes=100000-199999' }
		});
		const contentRange = res.headers.get('content-range') ?? '';
		const detail = `status=${res.status}, content-range=${contentRange}, accept-ranges=${res.headers.get('accept-ranges') ?? ''}`;
		expect(res.status, detail).toBe(206);
		expect(contentRange, detail).toMatch(/^bytes 100000-199999\//);
	} finally {
		await worker.stop();
	}
});

test('T7 · restart snaps the playhead to 0 and keeps decoding', async ({ world }) => {
	const { worker, phones, tv } = await stage(world);
	const phone = phones[0]!;
	try {
		// From ~4s the snap to 0 is past the TV's 1.5s jump threshold, so the jump fires. Waiting for the
		// playhead rather than sleeping for it: the claim needs a BEFORE that is genuinely past the threshold.
		await expect
			.poll(async () => (await readMaster(tv))?.currentTime ?? 0, {
				timeout: 15_000,
				message: 'the playhead never reached 2.5s, so a restart could not be distinguished from a no-op'
			})
			.toBeGreaterThan(2.5);
		const beforeRestart = await awaitMaster(tv);
		await transport.restart(phone).click();
		await tv.waitForTimeout(600);
		const afterRestart = await awaitMaster(tv);
		expect(
			afterRestart.currentTime,
			`T7a: before=${beforeRestart.currentTime.toFixed(2)}, after=${afterRestart.currentTime.toFixed(2)}`
		).toBeLessThan(2.0);

		await tv.waitForTimeout(1200);
		const restartPlaying = await awaitMaster(tv);
		expect(
			(restartPlaying.decoded ?? 0) - (afterRestart.decoded ?? 0),
			`T7b: decoded ${afterRestart.decoded} → ${restartPlaying.decoded}`
		).toBeGreaterThan(0);
		expect(
			restartPlaying.currentTime - afterRestart.currentTime,
			`T7b: currentTime ${afterRestart.currentTime.toFixed(2)} → ${restartPlaying.currentTime.toFixed(2)}`
		).toBeGreaterThan(0.4);
	} finally {
		await worker.stop();
	}
});

test('T1e/T1f · skip advances to the next song and that song decodes', async ({ world }) => {
	const { worker, phones, tv } = await stage(world, [TRACKS.caroline, TRACKS.believin], 2);
	const phone = phones[0]!;
	try {
		const preSkip = await awaitMaster(tv);
		await transport.skip(phone).click();
		// The swap is a server broadcast plus a slot reassignment; poll for the new src rather than dwelling.
		await expect
			.poll(async () => (await readMaster(tv))?.src ?? '', {
				timeout: 15_000,
				message: `T1e: skip must advance to the next song. before=${preSkip.src}`
			})
			.not.toBe(preSkip.src);
		const afterSkip = await awaitMaster(tv);
		expect(afterSkip.src, `T1e: before=${preSkip.src}, after=${afterSkip.src}`).toContain('instrumental');

		await tv.waitForTimeout(2000);
		const nextPlaying = await awaitMaster(tv);
		expect(
			nextPlaying.decoded ?? 0,
			`T1f: decoded=${nextPlaying.decoded}, paused=${nextPlaying.paused}, ` +
				`currentTime=${nextPlaying.currentTime.toFixed(2)} — a readyState-4 element sitting paused at ` +
				`currentTime 0 with only the initial preload burst (~24KB) decoded means the media loaded but was ` +
				`never played`
		).toBeGreaterThan(24576);
		expect(nextPlaying.paused, `T1f: paused=${nextPlaying.paused}`).toBe(false);
	} finally {
		await worker.stop();
	}
});

// DEFERRED BY THE OWNER, not fixed and not silently dropped. A seek past the duration DOES advance the rotation
// today; the owner's call is that this is acceptable for now. `test.fail` is the honest way to hold that: the test
// still RUNS and still fails for the documented reason, so the observation stays alive — and if the behaviour ever
// changes in either direction, this goes red and someone has to look. Re-decide by deleting this annotation.
//
// NOT rewritten to assert that advancing is correct, because nobody has claimed that. The old probe flagged it too
// and exited 1 for it, so both suites agree on what the product does; only its severity is a judgement call.
test('T2-oob · a seek beyond the duration must not advance the rotation', async ({ world }) => {
	// INSIDE the body, deliberately: `test.fail()` at file scope applies to every test in the file, not the next
	// one — it turned the other ten green tests in here into failures when written that way.
	test.fail(
		true,
		'a seek past EOF advances the rotation — deferred by the owner, so this records the behaviour rather than gating on it'
	);
	// The assertion is the OLD PROBE'S, defect-name and all: it asserts the rotation does NOT advance, and its own
	// message says what it observed instead. Any joined singer can force-skip a song — and possibly chain through
	// several — by seeking past EOF, which is why it was written as an authority claim rather than a transport one.
	const { worker, phones } = await stage(world, [TRACKS.caroline, TRACKS.believin, TRACKS.bohemian], 2);
	const phone = phones[0]!;
	try {
		const before = await serverPlayback(world.baseURL);
		expect(before.state.currentEntryId, 'there must be a current song to seek against').not.toBeNull();
		expect(before.state.isPlaying, 'the room must be playing for the seek to reach the element').toBe(true);

		await sendPlayerCommand(phone, { cmd: 'seek', positionSec: 9999 });
		await phone.waitForTimeout(1800);
		const after = await serverPlayback(world.baseURL);
		expect(
			after.state.currentEntryId,
			`before.current=${before.state.currentEntryId}, after.current=${after.state.currentEntryId}, ` +
				`isPlaying=${after.state.isPlaying} — expected: the seek is clamped or ignored; observed: the queue advanced`
		).toBe(before.state.currentEntryId);
	} finally {
		await worker.stop();
	}
});

test('T6 · skipping the last song returns the server to no-current', async ({ world }) => {
	const { worker, phones, tv } = await stage(world, [TRACKS.caroline, TRACKS.believin], 2);
	const phone = phones[0]!;
	try {
		// DRAIN EVERY REMAINING TURN by skipping, so "the last song" is genuinely the last one: one processed
		// song can carry several turns, and a single skip would advance INTO the waiting one — correct rotation,
		// but currentEntryId stays set and the no-current assertion fires a phantom failure.
		for (let i = 0; i < 6; i++) {
			const { state } = await serverPlayback(world.baseURL);
			if (!state.currentEntryId) break;
			await transport.skip(phone).click();
			await tv.waitForTimeout(1200);
		}
		const srv = await serverPlayback(world.baseURL);
		expect(
			srv.state.currentEntryId,
			`T6a: currentEntryId=${srv.state.currentEntryId}, isPlaying=${srv.state.isPlaying}`
		).toBeNull();
		expect(srv.state.isPlaying, `T6b: isPlaying=${srv.state.isPlaying}`).toBe(false);
	} finally {
		await worker.stop();
	}
});

test('T5 · there is NO transport at all when there is nothing to play', async ({ world }) => {
	/* A STRONGER CLAIM THAN THIS ARM USED TO MAKE, and the rewrite is the point rather than a concession. It
	   asserted that restart, play/pause and skip were each `disabled` on a drained room. The band rendered
	   permanently, so `disabled` was the best answer available — and it left the design review's finding standing:
	   the brightest element on an idle screen was a filled play button that did nothing. Since proposal 13 the
	   strip stays, so the dock keeps one height, but on a drained room it reads "Nothing playing" and has no
	   transport at all, not a disabled one. The dock and the tab bar must still be ATTACHED, because the bottom of
	   the screen is still navigation. */
	const { worker, phones, tv } = await stage(world, [TRACKS.caroline], 1);
	const phone = phones[0]!;
	try {
		for (let i = 0; i < 6; i++) {
			const { state } = await serverPlayback(world.baseURL);
			if (!state.currentEntryId) break;
			await transport.skip(phone).click();
			await tv.waitForTimeout(1200);
		}
		expect((await serverPlayback(world.baseURL)).state.currentEntryId, 'the room must be drained first').toBeNull();
		// Waits for the emptiness to have REACHED the phone: the strip's copy is derived from the room the client
		// holds, so reading it before the broadcast lands measures the previous room.
		await expect(phone.locator(SEL.npStripIdle), 'T5a: a drained room reads "Nothing playing"').toHaveText(
			'Nothing playing',
			{ timeout: 10_000 }
		);
		expect(
			await phone.locator(`${SEL.npPlayPause}, ${SEL.npTransport}, ${SEL.npCheerKey}`).count(),
			'T5b: an idle strip has no transport to dispatch into the void'
		).toBe(0);
		expect(
			await phone.locator(SEL.dock).count(),
			'T5c: the dock must survive the strip standing down — it is the fixed container the tab bar lives in'
		).toBe(1);
		expect(
			await phone.locator(SEL.tabBar).count(),
			'T5d: the tab bar must still hold the bottom of the screen on a drained room'
		).toBe(1);
		// The stage agrees: with nothing current there is no media element left to command.
		const stageNow = await readStage(tv);
		expect(
			stageNow.elems.length,
			`the TV still holds ${stageNow.elems.length} media element(s) after the room drained`
		).toBe(0);
	} finally {
		await worker.stop();
	}
});
