// TV AUDIOCONTEXT RESUME — does the TV's AudioContext ever RUN with no gesture in the room?
//
// WHY IT MATTERS: the pitch shifter degrades to audible-but-UNSHIFTED when its context cannot run, so correct
// maths and dead ± buttons are both true at once on a television that never hands the page the gesture
// `resume()` requires. Three hypotheses, and the graph's own state is what tells them apart:
//   1. a context exists and cannot run → audio plays unshifted and ± appears dead. The fix is a gesture
//      affordance on /tv, NOT a change to the shifter.
//   2. no context was ever constructed → the graph never built; look at `active` for the audible slot.
//   3. a context is RUNNING → the context is not the cause; setShift is not reaching the worklet ratio.
// Both autoplay policies run SIDE BY SIDE, because granting autoplay grants the permission a real TV lacks
// (docs/E2E.md#autoplay) — so the arms are launched here rather than declared per file, which Playwright only
// allows at file scope.
//
// ═══ THE OLD PROBE ASSERTED NOTHING, AND ITS ARMS MEASURED NOTHING ═══
// tests/e2e/probes/tv-audiocontext-resume.mjs has no `check()` at all: it printed both arms and then a VERDICT
// chosen from the three hypotheses above. Worse, it asked for the shift over a bare
// `new WebSocket('ws://…/ws?role=phone')` opened from Node — with no session cookie. server.ts gates
// `player:command` on `can({ singerId }, 'player:control')`, and capabilities.ts's `can` is
// `Boolean(actor?.singerId)`, so that frame was DROPPED. Both arms therefore observed a TV at keyShift 0, where
// the shifter deliberately builds no graph at all — which guarantees hypothesis 2 and would have printed the
// wrong verdict every time.
//
// So this port sends the shift the way a phone really does, from a socket opened inside the joined phone's own
// page, and turns each arm's verdict branch into an expect:
//   · GESTURELESS asserts the two things that are true on EITHER branch: a context IS constructed (hypothesis 2
//     excluded), and the element is captured ONLY INTO A RUNNING CONTEXT. That second one is the invariant
//     pitch-shift.ts states in capitals: "do NOT create the MediaElementSource — that permanently steals the
//     element's audio into a dead suspended graph, i.e. total silence." It is what keeps a gestureless room
//     audible-but-unshifted rather than silent forever, and it is the whole subject of this file.
//     WHY NOT PIN 'suspended' HERE: hypothesis 1 is unreachable on this browser. An AudioContext constructed in
//     a page this Chromium has already granted activation to is born 'running', and world/autoplay.ts's
//     `gateAudioContext` can only neuter `resume()` — it cannot make the CONSTRUCTOR return a suspended context.
//     Measured: states ["running"] with resume() intercepted and never reaching the native implementation. So the
//     arm asserts the invariant rather than a state this box cannot produce, and reports which branch it landed
//     on in its own failure message.
//   · AUTOPLAY GRANTED must land on hypothesis 3 — the context runs, the element is captured, and audio keeps
//     decoding. Anything else there is the shifter's own fault and not the policy's.
// The three readings per arm come from ONE graph-state snapshot and the later ones are meaningless without the
// earlier — a worklet cannot run inside a context that does not exist — so they share a test per arm.
//
// HOW "GESTURELESS" IS REACHED. Not by a flag: this Chromium ignores `--autoplay-policy` entirely, grants
// `navigator.userActivation.hasBeenActive` within ~271ms of a cold load, and Playwright issues every `evaluate`
// with CDP `userGesture: true`. world/autoplay.ts re-imposes the policy in-page instead, including
// `gateAudioContext`, and each arm asserts its own premise before reading anything.
import { chromium, type Page } from '@playwright/test';
import { test, expect } from '../../world/fixtures';
import { startFakeWorker } from '../../world/workers';
import { resolveChromium } from '../../world/chromium';
import { openBrowseFromHome } from '../../world/actors';
import { autoplayIsBlocked, requireActivationForPlayback } from '../../world/autoplay';
import {
	armGraphHook,
	awaitMaster,
	readGraphState,
	readMaster,
	sendPlayerCommand,
	serverPlayback,
	singTrack,
	TRACKS
} from './audio-probe-support';

/** The config's own launch args, which a per-test launch must re-state: `launchOptions` is REPLACED, not merged,
 *  so an arm that forgets `executablePath` fails on Playwright's own version resolution. */
const BASE_ARGS = ['--no-sandbox', '--disable-gpu'];

test('gestureless — a +2 shift builds a graph, and captures the element only into a running context', async ({
	world
}) => {
	const worker = await startFakeWorker(world);
	// Queued through the REAL phone UI: an invented singerId is rejected, which would leave the TV on the lobby
	// with no media element at all — and a missing AudioContext proves nothing there.
	const phone = await world.openPhone('T17Gestureless');
	await openBrowseFromHome(phone);
	await singTrack(phone, world.baseURL, TRACKS.caroline);

	const browser = await chromium.launch({ executablePath: resolveChromium(), args: BASE_ARGS });
	try {
		const context = await browser.newContext({ baseURL: world.baseURL, viewport: { width: 1920, height: 1080 } });
		const tv: Page = await context.newPage();
		// Instrumented BEFORE any app script: reading `.state` after the fact cannot tell you whether a context
		// was ever created. The policy goes on in the same breath and for the same reason — a television grants no
		// gesture, so `play()` must be refused here too, or the arm is measuring a TV somebody walked up to.
		await armGraphHook(tv);
		await requireActivationForPlayback(tv, { gateAudioContext: true });
		await tv.goto(`/tv?room=${encodeURIComponent(world.code)}`);
		expect(
			await autoplayIsBlocked(tv),
			'world/autoplay.ts is not in force, so this arm is not measuring a television that was never touched'
		).toBe(true);
		// THROWS rather than reading null, so "no media" and "not yet" stay distinguishable.
		await awaitMaster(tv);
		expect(
			(await readGraphState(tv))?.contexts,
			'at keyShift 0 the shifter must build nothing — otherwise the readings below are not about the shift'
		).toBe(0);

		await sendPlayerCommand(phone, { cmd: 'key', semitones: 2 });
		// PRECONDITION, and the one the old probe silently failed: if the command never reached authoritative
		// state, every reading below is of an unshifted TV.
		await expect
			.poll(async () => (await serverPlayback(world.baseURL)).state.keyShift, {
				timeout: 10_000,
				message: 'the +2 never reached playback state, so nothing downstream is about a shifted song'
			})
			.toBe(2);

		let graph = await readGraphState(tv);
		await expect
			.poll(
				async () => {
					graph = await readGraphState(tv);
					return graph?.contexts ?? 0;
				},
				{
					timeout: 15_000,
					message:
						'no AudioContext was ever constructed under a shift of +2 — hypothesis 2: the graph never built. ' +
						'Look at `active` for the audible slot.'
				}
			)
			.toBeGreaterThanOrEqual(1);
		// THE INVARIANT, on whichever branch this browser landed: an element is captured ONLY into a context that
		// is running. A MediaElementSource on a dead graph is permanent silence, where the degradation the product
		// accepts is audible-but-unshifted.
		const running = graph?.contextStates.includes('running') ?? false;
		const capturedIntoDeadGraph = (graph?.sources.length ?? 0) > 0 && !running;
		expect(
			capturedIntoDeadGraph,
			`ctx states ${JSON.stringify(graph?.contextStates)}, sources ${JSON.stringify(graph?.sources)}, ` +
				`${graph?.resumeCalls} resume() call(s) reaching the native implementation. ` +
				(running
					? `This box landed on hypothesis 3 — the context RUNS with nothing having touched the page, so the ` +
						`context is not the cause and a dead ± is setShift not reaching the worklet ratio.`
					: `This box landed on hypothesis 1 — the context cannot run, so audio plays UNSHIFTED and the ± ` +
						`buttons appear dead. The fix is a gesture affordance on /tv, NOT a change to the shifter.`) +
				` Either way, capturing the element into a graph that cannot run is total silence for the life of the page.`
		).toBe(false);
	} finally {
		await browser.close();
		await worker.stop();
	}
});

test('autoplay granted — a +2 shift builds a RUNNING graph that captures the element', async ({ world }) => {
	// NOT-A-TV, deliberately: this arm passes the flag the rest of the suite must never pass, so that a failure
	// in the gestureless arm above can be attributed to the policy rather than to the shifter.
	const worker = await startFakeWorker(world);
	const phone = await world.openPhone('T17Granted');
	await openBrowseFromHome(phone);
	await singTrack(phone, world.baseURL, TRACKS.caroline);

	const browser = await chromium.launch({
		executablePath: resolveChromium(),
		args: [...BASE_ARGS, '--autoplay-policy=no-user-gesture-required']
	});
	try {
		const context = await browser.newContext({ baseURL: world.baseURL, viewport: { width: 1920, height: 1080 } });
		const tv: Page = await context.newPage();
		await armGraphHook(tv);
		await tv.goto(`/tv?room=${encodeURIComponent(world.code)}`);
		const before = await awaitMaster(tv);
		expect((await readGraphState(tv))?.contexts, 'at keyShift 0 the shifter must build nothing').toBe(0);

		await sendPlayerCommand(phone, { cmd: 'key', semitones: 2 });
		await expect
			.poll(async () => (await serverPlayback(world.baseURL)).state.keyShift, {
				timeout: 10_000,
				message: 'the +2 never reached playback state, so nothing downstream is about a shifted song'
			})
			.toBe(2);

		let graph = await readGraphState(tv);
		// BOTH conditions in the one poll, deliberately. `running` is reached EARLY in `#buildOnce` — the
		// MediaElementSource capture happens later, past the `audioWorklet.addModule()` await — so polling on
		// `running` alone resolves mid-build and the `sources` assertion below then reads `[]` on a graph that was
		// merely unfinished. That is an instrument racing the subject, not a defect: the two arms of this claim
		// have to be observed at a moment when both can be true.
		await expect
			.poll(
				async () => {
					graph = await readGraphState(tv);
					return (graph?.contextStates.includes('running') ?? false) && (graph?.sources.length ?? 0) >= 1;
				},
				{
					timeout: 15_000,
					message:
						'with autoplay granted the context must RUN and capture the element: a suspended or absent one here ' +
						'is the shifter or the graph, since the permission a real TV lacks has been handed over explicitly.'
				}
			)
			.toBe(true);
		expect(graph?.contexts, `contexts=${graph?.contexts}`).toBeGreaterThanOrEqual(1);
		expect(
			graph?.sources.length,
			`the graph never captured the element (${JSON.stringify(graph?.sources)}), so the shift cannot reach the ` +
				`room however well the maths works`
		).toBeGreaterThanOrEqual(1);
		// …and the room is still audible while shifted: "audible but unshifted" is the degradation this file is
		// named for, so silence here is a different and worse failure. A MEASUREMENT INTERVAL, not a workaround —
		// decoded bytes are a rate.
		await tv.waitForTimeout(2000);
		const after = await readMaster(tv);
		expect(
			(after?.decoded ?? 0) - (before.decoded ?? 0),
			`the shifted song must keep decoding: decoded ${before.decoded} → ${after?.decoded}`
		).toBeGreaterThan(0);
	} finally {
		await browser.close();
		await worker.stop();
	}
});
