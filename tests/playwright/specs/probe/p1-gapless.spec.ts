// P1 — GAPLESS PLAYBACK AND AUTO-ADVANCE. Two library songs processed to real decodable audio, queued as two
// DIFFERENT singers, and the TV dense-polled at 40ms while the whole party happens. The old probe's F1–F9
// findings are the questions; each group of them that needs ONE observation is one test here.
//
// EVERY FINDING IS ANCHORED TO THE DECODED BYTE COUNTER AND THE WALL CLOCK, never to `paused`
// (docs/E2E.md#proving-audio). Buffering alone gives a stuck element a non-zero decoded count, so "played"
// requires a CLIMB past a floor that preload cannot reach.
//
// Ported from tests/e2e/probes/p1-gapless.mjs. Four things changed, all of them stated:
//   · SEVERITY BECOMES PASS/FAIL EXACTLY AS THE OLD PROBE SCORED IT. It `record`ed findings at four severities
//     and exited 1 only for CRITICAL or HIGH, so those are the expects below. The MEDIUM bands it tolerated are
//     named in comments beside the thresholds they sit under, and NOT asserted — tightening them here would be
//     a new claim wearing a ported one's clothes.
//   · the old header says "Autoplay is GRANTED, so this is NOT-A-TV" while its code passes no such flag. This
//     port passes none either, and takes ONE REAL TAP on the stage instead — the product's own route out of a
//     silent television (p13).
//   · F7 asked for `.attract` after the last song. `tvScreen` returns 'lobby' whenever anyone is in the room
//     (src/lib/tv/screen.ts), and this party has two joined singers, so the assertion is "the stage left the
//     playing state and stopped decoding" with either screen satisfying it. Requiring `.attract` specifically
//     would require an EMPTY room, which a two-singer gapless run is not.
//   · both songs are processed BEFORE either is queued, as the old probe did, so the first song does not start
//     while the second is still separating — and the sampler starts BEFORE the adds, so the opening song-intro
//     card is inside the window rather than half outside it.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, returnHomeFromBrowse } from '../../world/actors';
import {
	awaitMaster,
	processTrack,
	queueReadyTrack,
	readStage,
	tapStage,
	TRACKS,
	type ReadyMedia,
	type StageSample
} from './audio-probe-support';
import type { Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

/** ~25 Hz — dense enough to see a boundary the size of one video frame. The old probe's own figure, and the
 *  reason every wall-clock claim below is resolved to ±one sample. */
const SAMPLE_MS = 40;
/** The fixtures are 8s and ENCORE_SONG_INTRO_MS defaults to 2500, so one song-to-song cycle is ~18.5s of screen
 *  time. The budget leaves margin for the first intro card and the end settle. */
const OBSERVE_TIMEOUT_MS = 45_000;
/** Preload of a decode-only WebAudio buffer is 8–24KB, so anything past this can only have come from playback. */
const REAL_PLAYBACK_BYTES = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Sample = StageSample & { wallMs: number };

interface Timeline {
	samples: Sample[];
	song1: ReadyMedia;
	song2: ReadyMedia;
	singer1: string;
	singer2: string;
	worker: Awaited<ReturnType<typeof startFakeWorker>>;
	tv: Page;
}

/** Per-src: the first sample with any decoded bytes, the last sample where the count CLIMBED, and its peak. */
function decodingWindow(samples: Sample[], srcMatch: (src: string) => boolean) {
	let first = -1;
	let lastClimb = -1;
	let peak = 0;
	for (let i = 0; i < samples.length; i++) {
		const el = samples[i]!.elems.find((e) => e.src && srcMatch(e.src));
		if (!el) continue;
		const d = el.decoded ?? 0;
		if (d > 0 && first === -1) first = i;
		if (d > peak) {
			peak = d;
			lastClimb = i;
		}
	}
	return { first, lastClimb, peak };
}

/**
 * The first sample where a src climbed PAST the real-playback floor — i.e. the first byte that can only have
 * come from PLAYBACK. Not used by any assertion: it is the number the two structurally-red claims below need in
 * order to be re-decided, so it is reported in their failure messages rather than substituted into the claim.
 */
function firstPlaybackSample(samples: Sample[], srcMatch: (src: string) => boolean): number {
	return samples.findIndex((s) =>
		s.elems.some((e) => e.src && srcMatch(e.src) && (e.decoded ?? 0) >= REAL_PLAYBACK_BYTES)
	);
}

/** Distinct decoded-carrying src strings so far — the old probe's early-exit signal for "both songs were seen". */
function distinctDecodedSrcs(samples: Sample[]): Set<string> {
	const seen = new Set<string>();
	for (const row of samples) {
		for (const el of row.elems) if ((el.decoded ?? 0) > 0 && el.src) seen.add(el.src);
	}
	return seen;
}

/** Maximal runs of samples where the song-intro card was up. */
function introCards(samples: Sample[]) {
	const cards: { startI: number; endI: number; name: string; song: string; label: string }[] = [];
	let cur: (typeof cards)[number] | null = null;
	for (const [i, s] of samples.entries()) {
		const up = s.upNext.visible && s.upNext.kind === 'next' ? s.upNext : null;
		if (up) {
			if (!cur) cur = { startI: i, endI: i, name: up.name, song: up.song, label: up.label };
			else cur.endI = i;
		} else if (cur) {
			cards.push(cur);
			cur = null;
		}
	}
	if (cur) cards.push(cur);
	return cards;
}

/**
 * THE OBSERVATION. Two singers, two processed songs, one 40ms timeline over the whole party.
 *
 * The sampler runs WHILE the adds happen, because the opening song-intro card is only ~2.5s long and starting
 * the loop after the second add would clip it — which reads as a card that dismissed early.
 */
async function observeParty(world: World): Promise<Timeline> {
	const worker = await startFakeWorker(world);
	const singer1 = 'Alice';
	const singer2 = 'Bob';
	const alice = await world.openPhone(singer1);
	const bob = await world.openPhone(singer2);
	await openBrowseFromHome(alice);
	await openBrowseFromHome(bob);
	// PROCESSED FIRST, both of them: the add action only renders on a READY song, and a song that starts while
	// the other is still separating has no pre-warm target to measure.
	const song1 = await processTrack(alice, world.baseURL, TRACKS.caroline);
	const song2 = await processTrack(bob, world.baseURL, TRACKS.believin);

	// TV FIRST, so observation starts before any queue mutation and the attract → playing entry is seen.
	const tv = await world.openTv();
	await expect(tv.locator(SEL.tvRoot)).toBeAttached();
	await tapStage(tv);

	const samples: Sample[] = [];
	const t0 = Date.now();
	const sampler = (async () => {
		let sawBothSongs = false;
		while (Date.now() - t0 < OBSERVE_TIMEOUT_MS) {
			const s: Sample = { ...(await readStage(tv)), wallMs: Date.now() - t0 };
			samples.push(s);
			if (distinctDecodedSrcs(samples).size >= 2) sawBothSongs = true;
			// Early exit once both songs have been heard and the stage has left the playing state, rather than
			// burning the whole budget. One more sample window locks in the terminal state.
			if (sawBothSongs && (s.attract || s.lobby)) {
				await sleep(SAMPLE_MS);
				samples.push({ ...(await readStage(tv)), wallMs: Date.now() - t0 });
				return;
			}
			await sleep(SAMPLE_MS);
		}
	})();

	await queueReadyTrack(alice, TRACKS.caroline);
	// The rotation is NOT rendered in the results view, so a .qrow count taken there times out on an empty
	// list. Clearing the search is what brings the queue back.
	await returnHomeFromBrowse(alice);
	// The server auto-starts song 1 on an idle add, so from here this add lands as UP-NEXT.
	await queueReadyTrack(bob, TRACKS.believin);
	await returnHomeFromBrowse(bob);
	await sampler;

	expect(samples.length, 'no timeline samples were collected').toBeGreaterThan(0);
	return { samples, song1, song2, singer1, singer2, worker, tv };
}

/** playbackRef resolves to instrumentalRef, so an element's src is /media/derived/stems/<mediaId>-instrumental.wav. */
const matcherFor = (m: ReadyMedia) => (src: string) =>
	src.includes(m.id) || (!!m.instrumentalRef && src.includes(m.instrumentalRef));

test('F1/F2 · both songs really play, the second with no human touch', async ({ world }) => {
	const { samples, song1, song2, worker } = await observeParty(world);
	try {
		const w1 = decodingWindow(samples, matcherFor(song1));
		const w2 = decodingWindow(samples, matcherFor(song2));
		expect(
			w1.peak,
			`over ${samples.length} samples, "${song1.title}" (${song1.instrumentalRef}) reached a peak decoded byte ` +
				`count of ${w1.peak} — below the ${REAL_PLAYBACK_BYTES}-byte real-playback floor, which is what buffering ` +
				`alone can produce. the room heard silence.`
		).toBeGreaterThanOrEqual(REAL_PLAYBACK_BYTES);
		// F2 IS THE AUTO-ADVANCE QUESTION. A peak that is non-zero but under the floor is the sharper defect: the
		// element is HOLDING song 2 and not playing it, which is auto-advance broken in the transport rather than in
		// the queue — check transport.ts's inputs (hasSrc / active / visible / playing) for whichever slot became
		// visible after the swap. A peak of zero instead means the server never advanced, or applyNowPlaying never
		// routed the new current onto a slot.
		expect(
			w2.peak,
			`song 2 never played — auto-advance is broken (peak decoded = ${w2.peak}B, floor ${REAL_PLAYBACK_BYTES}B). ` +
				(w2.first >= 0 && w2.peak > 0
					? `its element loaded and buffered but the byte counter never grew from playback.`
					: `its element never even loaded a byte.`)
		).toBeGreaterThanOrEqual(REAL_PLAYBACK_BYTES);
	} finally {
		await worker.stop();
	}
});

test('F3 · the song-to-song boundary is neither a dead-air seam nor double audio', async ({ world }) => {
	// ══ THIS CLAIM IS STRUCTURALLY AT WAR WITH F9, AND IT IS PORTED UNCHANGED ANYWAY. ══
	// The boundary is defined by the old probe as "song 1's last decoded CLIMB to song 2's FIRST DECODED BYTE".
	// Song 2's first decoded byte is now its PRE-WARM burst in the hidden slot — 24,576 bytes at currentTime 0,
	// seconds before the swap — which is the very thing F9 below insists must happen. So the subtraction reports
	// multiple seconds of "OVERLAP" on a handoff that is in fact clean, and it cannot pass while F9 does.
	// It is NOT re-aimed here, because that would be a new claim wearing a ported one's clothes: the numbers the
	// owner needs to re-decide it are in the failure message instead (the same boundary measured from song 2's
	// first byte PAST the real-playback floor). See this port's report.
	const { samples, song1, song2, worker } = await observeParty(world);
	try {
		const isSong1 = matcherFor(song1);
		const isSong2 = matcherFor(song2);
		const w1 = decodingWindow(samples, isSong1);
		const w2 = decodingWindow(samples, isSong2);
		expect(w1.lastClimb, 'song 1 never decoded, so there is no boundary to measure').toBeGreaterThanOrEqual(0);
		expect(w2.first, 'song 2 never decoded, so there is no boundary to measure').toBeGreaterThanOrEqual(0);

		const tEndA = samples[w1.lastClimb]!.wallMs;
		const tStartB = samples[w2.first]!.wallMs;
		const deltaMs = tStartB - tEndA;
		const playbackI = firstPlaybackSample(samples, isSong2);
		const detail =
			`wall-clock last decoded climb of song 1 at ${tEndA}ms; first decoded byte of song 2 at ${tStartB}ms ` +
			`(${deltaMs >= 0 ? `${deltaMs}ms of GAP` : `${-deltaMs}ms of OVERLAP`}). sample density ${SAMPLE_MS}ms, so ` +
			`the boundary is resolved to ±one sample. FOR REFERENCE ONLY, not the assertion: song 2 first passed the ` +
			`${REAL_PLAYBACK_BYTES}-byte playback floor at ` +
			`${playbackI >= 0 ? `${samples[playbackI]!.wallMs}ms, which puts the boundary at ${samples[playbackI]!.wallMs - tEndA}ms` : 'never'}.`;
		// The A/B swap is one composited frame with no network, so low tens of ms is the shape. The old probe scored
		// >400ms and <-80ms HIGH (a failing run) and 150..400ms MEDIUM (tolerated) — both HIGH thresholds are here.
		expect(deltaMs, `past ~250ms is an audible dead-air seam. ${detail}`).toBeLessThanOrEqual(400);
		expect(deltaMs, `negative is double audio. ${detail}`).toBeGreaterThanOrEqual(-80);
	} finally {
		await worker.stop();
	}
});

test('F4/F9 · one voice at a time, with the next song really pre-warmed', async ({ world }) => {
	const { samples, song1, song2, worker } = await observeParty(world);
	try {
		const isSong1 = matcherFor(song1);
		const isSong2 = matcherFor(song2);
		// F4 · DOUBLE AUDIO: do two srcs grow their decoded counters inside one sample window? A SINGLE such window
		// is sampling jitter — both counters moved between the same two reads — so the old probe scored 1 window LOW,
		// 2–3 MEDIUM, and only >3 HIGH. That last threshold is the assertion.
		let simulRows = 0;
		let firstSimulT = -1;
		let maxSimul = 0;
		for (let i = 1; i < samples.length; i++) {
			const prev = samples[i - 1]!;
			const cur = samples[i]!;
			const grew = new Set<string>();
			for (const el of cur.elems) {
				if (!el.src) continue;
				const before = prev.elems.find((p) => p.src === el.src);
				if (before && (el.decoded ?? 0) > (before.decoded ?? 0)) grew.add(el.src);
			}
			if (grew.size >= 2) {
				simulRows++;
				if (firstSimulT < 0) firstSimulT = cur.wallMs;
				maxSimul = Math.max(maxSimul, grew.size);
			}
		}
		expect(
			simulRows,
			`both slots grew their decoded counters in ${simulRows} window(s) (~${simulRows * SAMPLE_MS}ms), first at ` +
				`wall+${firstSimulT}ms, max ${maxSimul} srcs in one window — a sustained overlap means the room hears two ` +
				`songs at once. The hidden slot must be paused before the swap.`
		).toBeLessThanOrEqual(3);

		// F9 · the A/B pair must both be MOUNTED, and both must hold media at once: seeing only ever one <audio>
		// means every swap costs the visible slot a cold load — the whole feature defeated.
		const slotCounts = new Set(samples.map((s) => s.slotCount));
		expect(
			[...slotCounts],
			`the .slot count was never 2 across the run — the gapless controller expects two slot divs ` +
				`(src/routes/tv/+page.svelte's two <TvPlayer/> instances)`
		).toContain(2);
		const maxConcurrent = samples.reduce((m, s) => Math.max(m, s.elems.length), 0);
		expect(
			maxConcurrent,
			`max concurrent audio/video elements in the DOM = ${maxConcurrent}. Staying at one means the hidden slot ` +
				`never carried a pre-warm buffer while the visible slot played: syncSlots should set ` +
				`slotMedia.B = mediaOf(upNext) whenever an upNext exists, and TvPlayer's {#if media && isPlayable(media)} ` +
				`gate must accept it. Either way the gapless swap has no buffer to swap TO.`
		).toBeGreaterThanOrEqual(2);
		// F9b · and they must have held the two DIFFERENT songs at the same moment.
		const overlapMountSamples = samples.filter(
			(s) => s.elems.some((e) => e.src && isSong1(e.src)) && s.elems.some((e) => e.src && isSong2(e.src))
		).length;
		expect(
			overlapMountSamples,
			`across ${samples.length} samples no single moment carried both song srcs — slot B did not pre-warm song 2 ` +
				`while slot A played song 1, so the "warm the next song" half of gapless swapping never ran.`
		).toBeGreaterThan(0);
	} finally {
		await worker.stop();
	}
});

test('F5 · the song-intro card is rendered, holds its nominal beat, and names its singer', async ({ world }) => {
	const { samples, singer1, singer2, worker } = await observeParty(world);
	try {
		// ENCORE_SONG_INTRO_MS defaults to 2500ms and the room goes openedOnce=false → true, so the card should
		// appear at least once at the start of song 1 and once at the swap. The old probe asserted only its
		// PRESENCE and then judged each card it actually saw, so a missing SECOND card is not a failure here
		// either — it is a number in this message. (It IS missing on this tree: `onprewarmed` hands
		// `ctl.onHiddenReady` a MEDIA id while the controller compares it against an ENTRY id, so the gapless swap
		// never fires and the between-songs card never gets its way in. See this port's report.)
		const cards = introCards(samples);
		expect(
			cards.length,
			`no song-intro card was ever rendered. See src/routes/tv/+page.svelte (onFirstSongReady + onVisibleEnded ` +
				`→ holdSongIntro).`
		).toBeGreaterThanOrEqual(1);
		for (const [k, c] of cards.entries()) {
			const held = samples[c.endI]!.wallMs - samples[c.startI]!.wallMs;
			// Nominal 2500ms, ±SAMPLE_MS at each edge. The old probe scored |drift| > 400ms MEDIUM and > 1200ms
			// HIGH; only the HIGH threshold is asserted.
			expect(
				Math.abs(held - 2500),
				`song-intro card #${k + 1} (label="${c.label}" name="${c.name}" song="${c.song}") held ~${held}ms against ` +
					`a nominal 2500ms, sample resolution ±${SAMPLE_MS}ms. See holdSongIntro.`
			).toBeLessThanOrEqual(1200);
			expect(
				c.name,
				`card #${k + 1} named the wrong singer: this is either the two-singer ordering being backwards or ` +
					`introEntry being derived from upNext (which advances mid-card). See the introEntry capture. ` +
					`NOT asserted, deliberately — the old probe scored a card naming the wrong SONG as MEDIUM: this one ` +
					`named "${c.song}".`
			).toContain(k === 0 ? singer1 : singer2);
		}
	} finally {
		await worker.stop();
	}
});

test('F6 · the lower third stops naming the previous singer at the swap', async ({ world }) => {
	// ══ SAME STRUCTURAL PROBLEM AS F3, AND ALSO PORTED UNCHANGED. ══
	// The old probe reads the name "during song 2" three samples after song 2's FIRST DECODED BYTE — which is now
	// the pre-warm burst, while song 1 is still on screen and the lower third correctly still says song 1's
	// singer. So the comparison is of two moments inside song 1. Left as written; the message carries the reading
	// taken at song 2's first byte past the playback floor, which is the number that re-decides it.
	const { samples, song1, song2, worker } = await observeParty(world);
	try {
		const w1 = decodingWindow(samples, matcherFor(song1));
		const w2 = decodingWindow(samples, matcherFor(song2));
		expect(w1.first, 'song 1 never decoded').toBeGreaterThanOrEqual(0);
		expect(w2.first, 'song 2 never decoded').toBeGreaterThanOrEqual(0);
		const nameDuringSong1 = samples[w1.first + 3]?.lowerThird.name ?? samples[w1.first]!.lowerThird.name;
		const nameDuringSong2 = samples[w2.first + 3]?.lowerThird.name ?? samples[w2.first]!.lowerThird.name;
		const flipI = samples.findIndex(
			(s, i) => i >= w1.first && !!s.lowerThird.name && s.lowerThird.name !== nameDuringSong1
		);
		const playbackI = firstPlaybackSample(samples, matcherFor(song2));
		expect(
			nameDuringSong1 && nameDuringSong2 && nameDuringSong1 !== nameDuringSong2,
			`.ls-name did not update between songs: during song 1 (near sample ${w1.first}) "${nameDuringSong1}", ` +
				`during song 2 (near sample ${w2.first}) "${nameDuringSong2}". The room would keep the old singer's name ` +
				`on the wall through the next song. The change was first observed at ` +
				`wall+${flipI >= 0 ? `${samples[flipI]!.wallMs}ms` : 'never'}; song 2's first decoded byte was at ` +
				`wall+${samples[w2.first]!.wallMs}ms. FOR REFERENCE ONLY, not the assertion: at song 2's first byte past ` +
				`the ${REAL_PLAYBACK_BYTES}-byte playback floor ` +
				`${playbackI >= 0 ? `(wall+${samples[playbackI]!.wallMs}ms) the name was "${samples[playbackI]!.lowerThird.name}"` : 'the floor was never passed'}.`
		).toBe(true);
	} finally {
		await worker.stop();
	}
});

test('F7 · the stage lets go once the last song has ended', async ({ world }) => {
	const { samples, song2, worker } = await observeParty(world);
	try {
		const w2 = decodingWindow(samples, matcherFor(song2));
		expect(w2.lastClimb, 'song 2 never decoded, so there is no end-of-run to judge').toBeGreaterThanOrEqual(0);
		// `.attract` is only reachable with an EMPTY room (src/lib/tv/screen.ts's tvScreen), and this party has two
		// joined singers, so the lobby is the correct terminal screen here — see the header.
		const tailStart = Math.min(w2.lastClimb + 1, samples.length - 1);
		const tail = samples.slice(tailStart);
		const lastRow = samples[samples.length - 1]!;
		const lastEl = lastRow.elems.find((e) => e.src && matcherFor(song2)(e.src));
		expect(
			tail.some((s) => s.attract || s.lobby),
			lastEl && !lastEl.paused && !lastEl.ended
				? `observation ended while song 2 was still playing, so end-of-run behaviour was never reached: tail ` +
						`${tail.length} samples, last element paused=${lastEl.paused} ended=${lastEl.ended} ` +
						`currentTime=${lastEl.currentTime.toFixed(2)}s`
				: `the TV never left the playing state after the last song ended: tail ${tail.length} samples, last ` +
						`element paused=${lastEl?.paused} ended=${lastEl?.ended} ` +
						`currentTime=${lastEl?.currentTime?.toFixed(2)}s. See src/lib/tv/screen.ts + src/lib/tv/gapless.ts ` +
						`(onEnded with no upNext).`
		).toBe(true);
		const stillDecoding = tail.some((s) =>
			s.elems.some((e) => (e.decoded ?? 0) > (samples[tailStart - 1]?.elems.find((p) => p.src === e.src)?.decoded ?? 0))
		);
		expect(
			stillDecoding,
			`something kept decoding after the last song stopped growing (${tail.length} tail samples)`
		).toBe(false);
	} finally {
		await worker.stop();
	}
});

test('F8 · the instrumental plays through <audio>, not <video>', async ({ world }) => {
	// WebKit documents FLAC for <audio> only, and an audio-only stream inside a <video> can decode SILENTLY on
	// some browsers — so the tag that carries the decode is itself a claim. One short observation is enough: the
	// question is which tag ever had a decoded byte.
	const worker = await startFakeWorker(world);
	try {
		const phone = await world.openPhone('Tagger');
		await openBrowseFromHome(phone);
		await processTrack(phone, world.baseURL, TRACKS.caroline);
		const tv = await world.openTv();
		await queueReadyTrack(phone, TRACKS.caroline);
		await awaitMaster(tv);
		await tapStage(tv);
		const decodingTags = new Set<string>();
		await expect
			.poll(
				async () => {
					for (const el of (await readStage(tv)).elems) {
						if ((el.decoded ?? 0) > 0) decodingTags.add(el.tag);
					}
					return decodingTags.size > 0;
				},
				{ timeout: 20_000, message: 'nothing ever decoded a byte, so there is no tag to judge' }
			)
			.toBe(true);
		expect(
			[...decodingTags],
			`tags observed decoding: ${[...decodingTags].join(', ')}. The master element belongs in ` +
				`src/lib/tv/TvPlayer.svelte as an <audio>.`
		).not.toContain('VIDEO');
		expect([...decodingTags]).toContain('AUDIO');
	} finally {
		await worker.stop();
	}
});
