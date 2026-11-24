// P2 — THE GUIDING TRACK: the original vocals mixed back UNDER the instrumental. It drives `guideLevel` (null
// inherits the room default, 0 is explicitly off, n is a per-song override clamped to [0,1]), the reset to null
// on every song boundary, and the level the TV actually applies.
//
// ═══ THERE IS NO SECOND <audio> ELEMENT TO MEASURE ═══
// A guide carried on a SECOND <audio> element beside the master, held in time by a governor, was removed
// on purpose. src/lib/contract/lyrics/guide-level.ts says why in the
// type itself:
//
//     THERE IS DELIBERATELY NO TWO-ELEMENT PATH: two elements can only be held together by comparing reported
//     `currentTime`, which EXCLUDES output latency, so a governor converges on a signal that does not describe
//     what the ear hears. A discriminated union rather than a boolean, so re-adding that path means changing
//     this TYPE and cannot creep in as an `if`.
//
// Today the guide is ONE 4-channel file — `guideMixRef`, channels 2/3 the isolated vocals — played by the one
// master element and pulled apart by a split PitchShiftGraph, whose two GainNodes are the master level and the
// guide level. `hasGuidingTrack` reads `guideMixRef`, NOT `vocalsRef`.
//
// So each claim below says which of three things it is:
//   [SAME] the identical reading on the identical thing.
//   [MOVED] the same claim, read off the node that now carries it. The master's `.volume` and the guide
//           element's `.volume` became gain[0] and gain[1] of the split graph; "the guide element mounted with a
//           vocals src" became "the master holds the 4-channel MIX", which `masterSrcPlan` commits ONLY once the
//           split graph has confirmed a running context — so the src IS the evidence the graph routed.
//   [DROPPED] not asserted, with the reason. Nothing is quietly weakened: the dropped ones are listed at the foot
//           of this file.
//
// It reads element and graph state, never audio: docs/E2E.md#proving-audio. HIGH/MEDIUM findings are asserted
// as well as CRITICAL, because every one of them has a stated threshold; the reason to soften them ("sync
// numbers go flaky under load") applied only to the governor measurements, which are gone.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue } from '../../world/actors';
import {
	armGraphHook,
	awaitMaster,
	readGraphState,
	readMaster,
	sendPlayerCommand,
	serverPlayback,
	singTrack,
	tapStage,
	TRACKS,
	type GraphState,
	type ReadyMedia
} from './audio-probe-support';
import type { Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

/** The room default at boot. `clampGuideLevel` rounds to whole percent, so these compare exactly. */
const ROOM_DEFAULT_OFF = 0;
const PER_SONG_LEVEL = 0.15;
const ROOM_DEFAULT_ON = 0.3;

interface Stage {
	worker: Awaited<ReturnType<typeof startFakeWorker>>;
	phone: Page;
	tv: Page;
	media: ReadyMedia[];
}

/**
 * A room whose songs carry a GUIDE MIX. `guideMix` is opt-in on the fake worker and is the ONLY way to reach the
 * enabled arm of this feature — `hasGuidingTrack` reads `guideMixRef`, and nothing else publishes one.
 *
 * The hook is ARMED rather than installed: a guide-mix song builds its split graph EAGERLY at mount
 * (`wantsEagerGraph`), so a hook applied after load would miss the construction it exists to observe.
 */
async function stage(world: World, tracks = [TRACKS.caroline, TRACKS.believin]): Promise<Stage> {
	const worker = await startFakeWorker(world, { guideMix: true });
	const phone = await world.openPhone('Guide');
	await openBrowseFromHome(phone);
	const media: ReadyMedia[] = [];
	for (const track of tracks) media.push(await singTrack(phone, world.baseURL, track));
	for (const m of media) {
		expect(m.guideMixRef, `"${m.title}" has no guideMixRef, so there is no guiding track to drive`).toBeTruthy();
	}
	const tv = await world.openTv();
	await armGraphHook(tv);
	await tv.reload();
	// The SHELL first: a mouse click dispatched into a document that has not finished loading is a click the
	// renderer can drop, and then the tap below buys no activation at all.
	await tv.locator(SEL.tvRoot).first().waitFor({ state: 'attached', timeout: 30_000 });
	// ONE REAL TAP, AND IT COMES FIRST. The split graph refuses to capture the element unless its AudioContext is
	// RUNNING, and a context is only resumable from a gesture — so on a guide-mix song, which builds EAGERLY the
	// moment the element mounts, a tap that arrives after the mount is a tap that arrives after the decision. The
	// gate then resolves `denied`, the plain instrumental plays, and every reading below would be measuring the
	// fallback instead of the feature.
	await tapStage(tv);
	// The ELEMENT, not its src: `masterSrcPlan` deliberately commits no src at all while the gate is `pending`, so
	// waiting for a src here would blame the missing element for a graph that is merely still building.
	// `awaitMixSrc` is what each test below waits on, and it names the gate in its own failure.
	await tv.locator(SEL.mediaEl).first().waitFor({ state: 'attached', timeout: 30_000 });
	return { worker, phone, tv, media };
}

/**
 * Ask for a per-song level and prove it reached AUTHORITATIVE STATE before anything reads the TV. The two
 * failures are different bugs: a command the server dropped (it gates `guide` on `hasGuidingTrack`) is not a
 * level the TV failed to apply, and without this the second would be reported for the first.
 */
async function setGuideLevel(phone: Page, baseURL: string, level: number | null): Promise<void> {
	await sendPlayerCommand(phone, { cmd: 'guide', level });
	await expect
		.poll(async () => (await serverPlayback(baseURL)).state.guideLevel, {
			timeout: 10_000,
			message:
				`the server never took guideLevel=${level}. It gates \`guide\` on hasGuidingTrack(media), which reads ` +
				`guideMixRef — so either the mix is missing from the catalog or the socket had no session.`
		})
		.toBe(level);
}

/** The tolerances exist because a GainNode's value is a FLOAT32: 0.3 reads back as
 *  0.30000001192092896. `< 0.001` is used for a per-song level and `< 0.02` for the room default. */
function expectGain(actual: number | null, expected: number, tol: number, detail: string): void {
	expect(actual, detail).not.toBeNull();
	expect(Math.abs((actual ?? NaN) - expected), `${detail} (expected ${expected} ± ${tol})`).toBeLessThan(tol);
}

/** The split graph's two gains, in construction order: [master, guide] (PitchShiftGraph#buildOnce). */
async function guideGains(
	tv: Page
): Promise<{ master: number | null; guide: number | null; state: GraphState | null }> {
	const state = await readGraphState(tv);
	return { master: state?.gainValues[0] ?? null, guide: state?.gainValues[1] ?? null, state };
}

/** Poll the guide gain to a value, within the float32 tolerance used for it. */
async function awaitGuideGain(
	tv: Page,
	expected: number,
	why = 'the TV never applied the level to the guide gain'
): Promise<void> {
	const tol = expected === ROOM_DEFAULT_ON ? 0.02 : 0.001;
	await expect
		.poll(async () => Math.abs(((await guideGains(tv)).guide ?? NaN) - expected) < tol, {
			timeout: 10_000,
			message: why
		})
		.toBe(true);
}

/** Wait until the master element holds the 4-channel mix, which only a ROUTED split graph is handed. */
async function awaitMixSrc(tv: Page, media: ReadyMedia): Promise<void> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const src = (await readMaster(tv))?.src ?? '';
		if (src.includes(media.guideMixRef!)) return;
		if (Date.now() >= deadline) {
			// THE GRAPH STATE IS THE DIAGNOSIS, so it is read at the moment of failure rather than described in the
			// abstract: `contexts: 1, contextStates: ["closed"], gains: 0, sources: []` is PitchShiftGraph#buildOnce
			// bailing at its own `state !== 'running'` check and closing the context — the room then plays the plain
			// instrumental with no guide and NO hint, because only the pitch path has an `onpitchblocked`.
			const graph = await readGraphState(tv);
			throw new Error(
				`the master never took the guide mix (${media.guideMixRef}) within 20s; it is holding "${src}". ` +
					`masterSrcPlan commits the mix only when the split graph reports routed AND split, so this is the ` +
					`graph failing to build, not the level failing to apply.\n\ngraph: ${JSON.stringify(graph)}`
			);
		}
		await new Promise((r) => setTimeout(r, 150));
	}
}

test('[MOVED] at level 0 the guide is silent while the instrumental plays', async ({ world }) => {
	// WAS: "level 0: no vocals element mounted (wantsGuide=false at effectiveGuide=0)". There is no second
	// element to count now — the guide rides in the master's own file — so the reading moves to the gain that
	// decides whether the room hears it. The claim is unchanged: at effectiveGuide 0, nothing of the vocals
	// reaches the speakers.
	const { worker, tv, media } = await stage(world, [TRACKS.caroline]);
	try {
		await awaitMixSrc(tv, media[0]!);
		const { master, guide, state } = await guideGains(tv);
		expect(guide, `gains=${JSON.stringify(state?.gainValues)} — the guide pair must sit at 0`).toBe(ROOM_DEFAULT_OFF);
		expect(master, `gains=${JSON.stringify(state?.gainValues)} — the instrumental must be at full level`).toBe(1);
		const { state: playback } = await serverPlayback(world.baseURL);
		expect(playback.guideLevel, 'no per-song override has been set, so the server must still say null').toBeNull();
	} finally {
		await worker.stop();
	}
});

test('[MOVED] a per-song level of 0.15 puts the guide under the instrumental, both decoding', async ({ world }) => {
	// WAS four findings: the vocals element mounted with a vocals src; it decoded; the master kept decoding
	// beside it; and its `.volume` was 0.15 against the master's 1, strictly lower. With ONE element and one
	// playhead, "both decode" collapses into one reading — see [DROPPED] at the foot of the file — and the two
	// volumes are the split graph's two gains.
	const { worker, phone, tv, media } = await stage(world, [TRACKS.caroline]);
	try {
		await awaitMixSrc(tv, media[0]!);
		const before = await awaitMaster(tv);
		await setGuideLevel(phone, world.baseURL, PER_SONG_LEVEL);
		await awaitGuideGain(
			tv,
			PER_SONG_LEVEL,
			'the server holds the level but the TV never applied it to the guide gain'
		);
		const { master, guide, state } = await guideGains(tv);
		expectGain(guide, PER_SONG_LEVEL, 0.001, `guide gain, gains=${JSON.stringify(state?.gainValues)}`);
		expectGain(master, 1, 0.001, `master gain, gains=${JSON.stringify(state?.gainValues)}`);
		// STRICTLY LOWER: a guide as loud as the instrumental is the defect this number exists to catch.
		expect(guide! < master!, `guide=${guide} master=${master} — the guide must be quieter than the master`).toBe(true);
		// A MEASUREMENT INTERVAL, not a workaround: "the mix is decoding" is a rate, read over a
		// 2.5s window.
		await tv.waitForTimeout(2500);
		const after = await awaitMaster(tv);
		expect(
			(after.decoded ?? 0) - (before.decoded ?? 0),
			`the 4-channel mix must keep decoding: decoded ${before.decoded} → ${after.decoded}`
		).toBeGreaterThan(1000);
		// The server holds the override, which is what a reconnecting client would adopt.
		expect((await serverPlayback(world.baseURL)).state.guideLevel).toBe(PER_SONG_LEVEL);
	} finally {
		await worker.stop();
	}
});

test('[MOVED] pause holds the guide and resume brings it back at the same level', async ({ world }) => {
	// WAS: "pause holds the vocals element too (both elements paused together)", "resume: vocals still mounted
	// at .volume=0.15 (per-song override survived)" and "resume decodes the vocals again". One playhead now, so
	// "both paused together" is structural; what is still worth asserting is that the per-song override survives
	// the transport and that the decoder really restarts.
	const { worker, phone, tv, media } = await stage(world, [TRACKS.caroline]);
	try {
		await awaitMixSrc(tv, media[0]!);
		await setGuideLevel(phone, world.baseURL, PER_SONG_LEVEL);
		await awaitGuideGain(tv, PER_SONG_LEVEL);

		await sendPlayerCommand(phone, { cmd: 'pause' });
		await expect
			.poll(async () => (await readMaster(tv))?.paused ?? null, {
				timeout: 10_000,
				message: 'the pause never reached the TV'
			})
			.toBe(true);
		const paused = await awaitMaster(tv);

		await sendPlayerCommand(phone, { cmd: 'play' });
		await expect
			.poll(async () => (await readMaster(tv))?.paused ?? null, {
				timeout: 10_000,
				message: 'the resume never reached the TV'
			})
			.toBe(false);
		await tv.waitForTimeout(1500);
		const resumed = await awaitMaster(tv);
		expect(
			(resumed.decoded ?? 0) - (paused.decoded ?? 0),
			`resume must decode the mix again: decoded ${paused.decoded} → ${resumed.decoded}`
		).toBeGreaterThan(0);
		const { guide, state } = await guideGains(tv);
		expectGain(
			guide,
			PER_SONG_LEVEL,
			0.001,
			`the per-song override must survive pause/resume, gains=${JSON.stringify(state?.gainValues)}`
		);
		expect(resumed.src, 'and the element must still be holding the 4-channel mix').toContain(media[0]!.guideMixRef!);
	} finally {
		await worker.stop();
	}
});

test('[MOVED] a song change clears the per-song override back to the room default', async ({ world }) => {
	// WAS: "song change: guideLevel resets to null → at room default 0, vocals element unmounts". The unmount is
	// gone with the second element; the reset it was evidence FOR is the same, and is read twice — once on the
	// server's own state and once on the gain the next song plays at.
	const { worker, phone, tv, media } = await stage(world);
	try {
		await awaitMixSrc(tv, media[0]!);
		await setGuideLevel(phone, world.baseURL, PER_SONG_LEVEL);
		await awaitGuideGain(tv, PER_SONG_LEVEL);

		await sendPlayerCommand(phone, { cmd: 'skip' });
		// The new master src is the song-change signal.
		await awaitMixSrc(tv, media[1]!);
		expect(
			(await serverPlayback(world.baseURL)).state.guideLevel,
			'EPHEMERAL_RESET must clear guideLevel to null — not to 0 — or a room loses its default every song'
		).toBeNull();
		await expect
			.poll(async () => (await guideGains(tv)).guide, {
				timeout: 10_000,
				message: 'the fresh song must play at the room default (0), not at the previous singer’s override'
			})
			.toBe(ROOM_DEFAULT_OFF);
	} finally {
		await worker.stop();
	}
});

test('[MOVED] the room default applies to a fresh song with no override', async ({ world }) => {
	// WAS: "room default 0.30 applies to a fresh song with no per-song override" (vocals mounted at .volume=0.30)
	// plus "room default: vocals element decodes bytes (mount alone would not prove audio flow)".
	const { worker, phone, tv, media } = await stage(world);
	try {
		await awaitMixSrc(tv, media[0]!);
		await world.becomeHost(phone);
		const res = await phone.request.put(`${world.baseURL}/api/settings/room`, {
			data: { guideLevelDefault: ROOM_DEFAULT_ON }
		});
		expect(res.ok(), `PUT /api/settings/room answered ${res.status()}`).toBe(true);
		// settings:changed must land BEFORE the skip: lose that race and the fresh slot mounts with the
		// pre-broadcast default of 0 — a different failure than the one under test.
		await awaitGuideGain(tv, ROOM_DEFAULT_ON, 'the room default never reached the TV, so the skip would race it');

		await sendPlayerCommand(phone, { cmd: 'skip' });
		await awaitMixSrc(tv, media[1]!);
		const before = await awaitMaster(tv);
		const { master, guide, state } = await guideGains(tv);
		expectGain(
			guide,
			ROOM_DEFAULT_ON,
			0.02,
			`effectiveGuideLevel(null, ${ROOM_DEFAULT_ON}) must be ${ROOM_DEFAULT_ON} on the fresh song — ` +
				`gains=${JSON.stringify(state?.gainValues)}`
		);
		expectGain(master, 1, 0.001, `master gain, gains=${JSON.stringify(state?.gainValues)}`);
		// MOUNT ALONE WOULD NOT PROVE AUDIO FLOW, so the decoder is read across a dwell as well.
		await tv.waitForTimeout(2000);
		const after = await awaitMaster(tv);
		expect(
			(after.decoded ?? 0) - (before.decoded ?? 0),
			`the fresh song's mix must decode: decoded ${before.decoded} → ${after.decoded}`
		).toBeGreaterThan(0);
	} finally {
		await worker.stop();
	}
});

test('[MOVED] a guide at the digital floor still offers the control and still plays', async ({ world }) => {
	// WAS three findings under FAKE_SILENT_VOCALS: `vocalsRef` IS set (a silent guide must not fail the
	// process), the phone still OFFERS the control, and the TV mounts the guide anyway.
	//
	// WHAT MOVED: the control is offered on `guideMixRef` now, never on `vocalsRef` — `hasGuidingTrack` is
	// DEFINED as `guidePath(m).kind !== 'none'` precisely so the phone's gate and the TV's playback cannot drift.
	// So this drives BOTH faults together: silent vocals AND a published mix, which is the real shape of "the
	// separator produced a guide with nothing audible in it".
	const worker = await startFakeWorker(world, { guideMix: true, silentVocals: true });
	const phone = await world.openPhone('Floor');
	await openBrowseFromHome(phone);
	try {
		const media = await singTrack(phone, world.baseURL, TRACKS.caroline);
		// A silent guide must not fail the process: the song is READY, with both refs.
		expect(media.stemStatus, 'a silent guide must not fail the separation').toBe('ready');
		expect(media.vocalsRef, 'vocalsRef must still be published for a silent vocals stem').toBeTruthy();
		expect(media.guideMixRef, 'the guide mix must still be published for a silent vocals stem').toBeTruthy();

		const tv = await world.openTv();
		await armGraphHook(tv);
		await tv.reload();
		// TAP BEFORE THE MOUNT, for the reason `stage()` gives: the eager split build takes its decision the moment
		// the element appears, and a context with no activation behind it resolves the gate `denied`.
		await tv.locator(SEL.tvRoot).first().waitFor({ state: 'attached', timeout: 30_000 });
		await tapStage(tv);
		await tv.locator(SEL.mediaEl).first().waitFor({ state: 'attached', timeout: 30_000 });
		await awaitMixSrc(tv, media);

		// The phone still OFFERS the control, on /queue's now-playing card. `.gt.disabled` is the anchor the
		// component's own source names for this state; the range input's `disabled` property is not usable,
		// because bits-ui does not expose it as one.
		await openQueue(phone);
		await expect(phone.locator(SEL.guidingTrackRoot)).toBeAttached();
		await expect(
			phone.locator(`${SEL.guidingTrackRoot}.disabled`),
			'the guide control must be OFFERED: hasGuidingTrack tests the presence of a mix, not its content'
		).toHaveCount(0);
		await expect(phone.locator(SEL.slider).first()).not.toBeDisabled();

		// …and the room is playing it, at the floor or not.
		const before = await awaitMaster(tv);
		await tv.waitForTimeout(2000);
		const after = await awaitMaster(tv);
		expect(
			(after.decoded ?? 0) - (before.decoded ?? 0),
			`the TV must play the mix anyway: decoded ${before.decoded} → ${after.decoded}`
		).toBeGreaterThan(0);
	} finally {
		await worker.stop();
	}
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// [DROPPED] — claims deliberately NOT asserted, and why.
//
// 1. "sync: max drift < 0.30s (GUIDE_RESEEK_SEC)" and "sync: avg drift stays inside a reasonable band
//    (< 0.15s)" — by design. Both would measure `vocals.currentTime - master.currentTime`, but there is ONE
//    element and ONE playhead, so the quantity is identically zero and no governor exists; guide-level.ts's
//    GuidePath type forbids the two-decoder path outright. Asserting "drift < 0.3" against a single playhead
//    would be a test that cannot fail, which is worse than no test.
// 2. "no Web Audio graph on the naked (unshifted) path" — FALSE, in the direction that matters: a guide-mix
//    song builds its graph EAGERLY at mount, because the guide does not exist until the splitter runs
//    (guide-mix-src.ts#wantsEagerGraph).
// 3. "vocalsRef absent" — world/workers.ts has `noVocals` and publishes NO guide mix by default, so the
//    DISABLED arm of the control is reachable. It is named here as the next thing to add.
