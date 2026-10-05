// P3 — DOES THE PITCH SHIFTER ACTUALLY MAKE A SOUND, AT THE RIGHT PITCH? It measures the rendered graph and
// the OUTPUT SAMPLES off a parallel analyser tap, never the UI's own claim about itself.
//
// THE FIXTURE IS WHAT MAKES IT DECISIVE. The audio the TV plays is the fake worker's instrumental: an 8s WAV
// of three equal-amplitude sines (world/audio.ts, via world/workers.ts), so an FFT peak lands cleanly on one
// partial and moves by exactly the pitch ratio. A real recording could not carry that property. The worker
// writes the SAME tone for every library track, so `WORKER_INSTRUMENTAL_HZ` — not the library file's own
// frequencies — is what an FFT off the stage must show.
//
// CRITICAL = silence or a wedged decoder; HIGH = wrong pitch (>3%) or label/state disagreement. The old probe
// exited 1 on ANY non-environment finding regardless of severity, so every one of them is an expect here.
//
// See docs/E2E.md#proving-audio.
//
// Ported from tests/e2e/probes/p3-key-shift.mjs. Two changes of MECHANISM, no change of claim:
//   · the ± keycaps and Restart are driven with REAL Playwright clicks where the old probe used
//     `evaluate(() => btn.click())`. A synthetic click grants no user activation, and this page's whole
//     subject is an AudioContext that needs one (docs/E2E.md#gestures).
//   · the TV takes ONE real tap before any shift, for the same reason. It builds nothing — TvPlayer's gesture
//     handler only re-attempts a shift that is already pending — so the keyShift-0 baseline below still
//     measures a graphless page.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue } from '../../world/actors';
import {
	attachTap,
	awaitMaster,
	installGraphHook,
	readGraphState,
	readTap,
	singTrack,
	tapStage,
	TRACKS,
	WORKER_INSTRUMENTAL_HZ,
	type TapRead
} from './audio-probe-support';
import type { Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

/** 2^(n/12) — one semitone is ~5.9%, which is why the tolerance below is 3%. */
const ratio = (n: number): number => Math.pow(2, n / 12);
const expectedHz = (n: number): number[] => WORKER_INSTRUMENTAL_HZ.map((f) => f * ratio(n));

/** A chord at amp 0.28/3 through Hann OLA is ~0.11–0.20 RMS; 0.02 is a very cautious floor. */
const RMS_FLOOR = 0.02;

/** True iff at least TWO expected partials are within `tolPct` of some measured partial. The three fixture
 *  partials are near-equal in magnitude, so WHICH wins the peak bin is unstable across runs — judging the top
 *  few against the expected set is the stable form of the question. */
function matches(measured: { hz: number }[], expected: number[], tolPct = 3): boolean {
	let hits = 0;
	for (const e of expected) {
		if (measured.some((m) => Math.abs(m.hz - e) / e < tolPct / 100)) hits++;
	}
	return hits >= 2;
}

const top3 = (m: TapRead | null): string =>
	(m?.partials ?? [])
		.slice(0, 3)
		.map((p) => `${p.hz.toFixed(1)}Hz`)
		.join(', ');

/** The rendered label IS the server-broadcast keyShift, which is what makes reading it a round trip. */
async function readKeyLabel(phone: Page): Promise<string> {
	/* `textContent`, NOT innerText, and the reason has CHANGED rather than gone away. The sheet's `.key .lab` was
	   `text-transform: uppercase`, so innerText returned "KEY" and an equality check on the reset state never
	   held. /queue's key label is app.css's `.control-label` — `font-size`, `font-weight`, `line-height`, `color`
	   and no transform at all — so the two reads agree today. What `textContent` still buys is that it does not
	   depend on that: a label dressed
	   with a transform later would silently break innerText, and this helper's whole job is to report the exact
	   string the server broadcast. */
	return ((await phone.locator(SEL.keyLabel).first().textContent()) ?? '').trim();
}

function parseKeyLabel(label: string): number | null {
	if (label === 'Key') return 0;
	// The minus in the label is U+2212, not ASCII.
	const m = /([+\-−])(\d+)/.exec(label);
	if (!m) return null;
	return m[1] === '+' ? Number(m[2]) : -Number(m[2]);
}

/**
 * Press ± until the label reports `target`. The keycaps are `.keys button` in source order: minus, plus — the
 * order verified from their accessible names, "Lower by one semitone" then "Raise by one semitone".
 * Returns what the label finally said, so a caller asserts on the reading rather than on a boolean.
 */
async function shiftTo(phone: Page, target: number): Promise<{ value: number | null; label: string }> {
	await openQueue(phone);
	const caps = phone.locator(SEL.keyBtn);
	let label = await readKeyLabel(phone);
	let current = parseKeyLabel(label);
	let safety = 20;
	while (current !== null && current !== target && safety-- > 0) {
		const before = current;
		await caps.nth(current < target ? 1 : 0).click();
		// The label only moves on the server's playback:state broadcast, so this waits for the ROUND TRIP
		// rather than for a local optimistic update.
		await expect
			.poll(async () => parseKeyLabel(await readKeyLabel(phone)), {
				timeout: 4_000,
				message: `the Key label never moved off ${before} after a keycap press`
			})
			.not.toBe(before);
		label = await readKeyLabel(phone);
		current = parseKeyLabel(label);
	}
	return { value: current, label };
}

async function restart(phone: Page): Promise<void> {
	await phone.getByRole(SEL.restart.role, { name: SEL.restart.name }).click();
}

/**
 * ONE reading of the output at `target`. The dwells are the physics: a ± press is a server round trip and then
 * a `postMessage` to the worklet, and the analyser needs fftSize/sampleRate = 171ms of audio in its window —
 * so a read taken the instant after a restart reads the tail of the PREVIOUS take.
 *
 * RESTARTED BEFORE EVERY READ because the fixture is 8s: without it the ladder below walks off the end of the
 * song, the server advances, and the element under measurement unmounts.
 */
async function measureAtShift(phone: Page, tv: Page, target: number): Promise<TapRead> {
	await shiftTo(phone, target);
	await phone.waitForTimeout(600);
	await restart(phone);
	await phone.waitForTimeout(700);
	return readTap(tv);
}

interface Stage {
	worker: Awaited<ReturnType<typeof startFakeWorker>>;
	phone: Page;
	tv: Page;
}

/** A room with `tracks` processed and queued by one singer, a TV that has been tapped once, and the hook in. */
async function stage(world: World, tracks: { title: string; q: string }[] = [TRACKS.caroline]): Promise<Stage> {
	const worker = await startFakeWorker(world);
	const phone = await world.openPhone('P3Singer');
	await openBrowseFromHome(phone);
	for (const track of tracks) await singTrack(phone, world.baseURL, track);
	const tv = await world.openTv();
	// Installed BEFORE any shift is possible. Nothing is missed: at keyShift 0 the shifter builds no graph.
	expect(await installGraphHook(tv), 'the probe could not wrap AudioContext on the TV page').toBe('installed');
	await awaitMaster(tv);
	await tapStage(tv);
	return { worker, phone, tv };
}

test('at keyShift 0 the audio decodes with no WebAudio graph at all', async ({ world }) => {
	const { worker, tv } = await stage(world);
	try {
		const t0 = await awaitMaster(tv);
		// A MEASUREMENT INTERVAL: decoded bytes are a rate, so "it is decoding" only exists as a difference.
		await tv.waitForTimeout(2500);
		const t1 = await awaitMaster(tv);
		const detail =
			`decoded ${t0.decoded} → ${t1.decoded}, currentTime ${t0.currentTime.toFixed(2)} → ` +
			`${t1.currentTime.toFixed(2)}`;
		expect((t1.decoded ?? 0) - (t0.decoded ?? 0), `baseline decoded byte count: ${detail}`).toBeGreaterThan(0);
		expect(t1.currentTime - t0.currentTime, `baseline playhead: ${detail}`).toBeGreaterThan(1.2);
		const hook = await readGraphState(tv);
		expect(hook?.contexts, `hook state: ${JSON.stringify(hook)}`).toBe(0);
	} finally {
		await worker.stop();
	}
});

test('the phone Key label is the keyShift the server broadcast back', async ({ world }) => {
	const { worker, phone } = await stage(world);
	try {
		// FOUR readings of ONE claim — the label is the server's own value, not a local echo — so they share a
		// test: each `shiftTo` below starts from where the last one left the room.
		const to1 = await shiftTo(phone, 1);
		expect(to1.value, `+1: the phone label is the same string the server broadcasts back (${to1.label})`).toBe(1);
		const to0 = await shiftTo(phone, 0);
		expect(to0.value, `back to 0 (${to0.label})`).toBe(0);
		const to2 = await shiftTo(phone, 2);
		expect(to2.label, `label at +2: ${JSON.stringify(to2.label)}`).toContain('+2');
		const toN3 = await shiftTo(phone, -3);
		// U+2212, the typographic minus the label actually renders.
		expect(toN3.label, `label at -3: ${JSON.stringify(toN3.label)}`).toMatch(/[−-]3/);
	} finally {
		await worker.stop();
	}
});

test('the first shift builds a worklet graph that reaches the speakers', async ({ world }) => {
	const { worker, phone, tv } = await stage(world);
	try {
		expect((await shiftTo(phone, 1)).value).toBe(1);
		// The TV takes the same broadcast, runs the wiring effect, builds the graph and resumes the context.
		// ONE SNAPSHOT, FOUR READINGS: they are facts about the same graph and the later ones are meaningless
		// without the earlier — a worklet cannot be constructed inside a context that does not exist.
		let hook = await readGraphState(tv);
		await expect
			.poll(
				async () => {
					hook = await readGraphState(tv);
					return (hook?.contexts ?? 0) >= 1 && (hook?.gains ?? 0) >= 1;
				},
				{
					timeout: 10_000,
					message: 'no AudioContext and GainNode were ever constructed on the first shift — the graph never built'
				}
			)
			.toBe(true);
		expect(hook?.contexts, `hook: ${JSON.stringify(hook)}`).toBeGreaterThanOrEqual(1);
		expect(hook?.gains, `hook: ${JSON.stringify(hook)}`).toBeGreaterThanOrEqual(1);
		expect(hook?.worklets, `worklets seen: ${JSON.stringify(hook?.worklets ?? [])}`).toContain('encore-pitch-shift');
		expect(
			hook?.reachedDestination,
			'a graph that does not connect to destination silences the room and no unit test catches it'
		).toBe(true);
		expect(hook?.contextStates, `ctx states: ${JSON.stringify(hook?.contextStates ?? [])}`).toContain('running');
	} finally {
		await worker.stop();
	}
});

test('at +1 semitone the element keeps decoding audio', async ({ world }) => {
	const { worker, phone, tv } = await stage(world);
	try {
		expect((await shiftTo(phone, 1)).value).toBe(1);
		await restart(phone);
		const a = await awaitMaster(tv);
		await tv.waitForTimeout(2500);
		const b = await awaitMaster(tv);
		expect(
			(b.decoded ?? 0) - (a.decoded ?? 0),
			`decoded ${a.decoded} → ${b.decoded} over 2.5s. Zero means the shifter silenced it.`
		).toBeGreaterThan(0);
	} finally {
		await worker.stop();
	}
});

test('across the shift ladder the output is audible and lands at 2^(n/12)', async ({ world }) => {
	const { worker, phone, tv } = await stage(world);
	try {
		// The ladder is ONE measurement pass: every reading comes off ONE tap on ONE graph, which is what makes
		// them comparable at all — a per-shift test would rebuild the graph and compare across two of them.
		expect((await shiftTo(phone, 1)).value).toBe(1);
		const tap = await attachTap(tv);
		expect(tap.ok, `analyser tap: ${JSON.stringify(tap)}`).toBe(true);

		const ladder = [0, 1, 2, 3, -1, -3, 5];
		const readings = new Map<number, TapRead>();
		for (const n of ladder) readings.set(n, await measureAtShift(phone, tv, n));

		for (const n of ladder) {
			const m = readings.get(n)!;
			const sign = n >= 0 ? '+' : '';
			// SILENCE IS THE WORSE DEFECT, so it is asserted first: a shifter that silences the room is worse
			// than one that shifts wrong. Shift 0 is in the ladder deliberately — through the BUILT graph it is
			// the ratio-1 passthrough, which must be audible too.
			expect(
				m.ok ? m.rms : -1,
				`shift ${sign}${n}: output is NOT silent (RMS > ${RMS_FLOOR}) — rms=${m.rms.toFixed(4)} ${m.why ?? ''}`
			).toBeGreaterThan(RMS_FLOOR);
		}
		for (const n of ladder) {
			if (n === 0) continue; // the ratio-1 arm is the baseline the others are read against
			const m = readings.get(n)!;
			const sign = n >= 0 ? '+' : '';
			expect(
				m.ok && matches(m.partials, expectedHz(n)),
				`shift ${sign}${n}: two of the chord partials must land at 2^(${n}/12)× their fixture ` +
					`frequencies. measured top: ${top3(m)}   expected: ${expectedHz(n)
						.map((f) => f.toFixed(1) + 'Hz')
						.join(', ')}`
			).toBe(true);
		}
	} finally {
		await worker.stop();
	}
});

test('from 0 to +2 every partial moves by the same 2^(2/12), at the same loudness', async ({ world }) => {
	const { worker, phone, tv } = await stage(world);
	try {
		// A BARE PEAK-TO-PEAK RATIO IS MEANINGLESS here — the FFT may pick two different partials at the two
		// shifts — so this walks each fixture partial to its nearest measured neighbour and averages.
		expect((await shiftTo(phone, 1)).value).toBe(1);
		const tap = await attachTap(tv);
		expect(tap.ok, `analyser tap: ${JSON.stringify(tap)}`).toBe(true);
		const at0 = await measureAtShift(phone, tv, 0);
		const at2 = await measureAtShift(phone, tv, 2);
		expect(at0.ok && at2.ok, `readings: 0=${JSON.stringify(at0.why)} +2=${JSON.stringify(at2.why)}`).toBe(true);

		const closest = (freq: number, arr: { hz: number }[]) =>
			arr.reduce((best, p) => (Math.abs(p.hz - freq) < Math.abs(best.hz - freq) ? p : best), arr[0]!);
		let sum = 0;
		let n = 0;
		for (const fx of WORKER_INSTRUMENTAL_HZ) {
			const c0 = closest(fx, at0.partials);
			const c2 = closest(fx * ratio(2), at2.partials);
			if (c0 && c2) {
				sum += c2.hz / c0.hz;
				n++;
			}
		}
		const nearest = n > 0 ? sum / n : NaN;
		expect(
			Math.abs(nearest - ratio(2)) / ratio(2),
			`per-partial mean ratio = ${nearest.toFixed(4)}, dominant-peak ratio = ` +
				`${(at2.peakHz / at0.peakHz).toFixed(4)}, expected = ${ratio(2).toFixed(4)}`
		).toBeLessThan(0.03);
		expect(
			Math.abs(Math.log2(at2.rms / at0.rms)),
			`RMS must be roughly preserved: rms@0=${at0.rms.toFixed(4)} rms@+2=${at2.rms.toFixed(4)} ` +
				`ratio=${(at2.rms / at0.rms).toFixed(3)}`
		).toBeLessThan(1);
	} finally {
		await worker.stop();
	}
});

test('at +2 the pitch survives a pause and resume', async ({ world }) => {
	const { worker, phone, tv } = await stage(world);
	try {
		expect((await shiftTo(phone, 2)).value).toBe(2);
		const tap = await attachTap(tv);
		expect(tap.ok, `analyser tap: ${JSON.stringify(tap)}`).toBe(true);
		const before = await measureAtShift(phone, tv, 2);

		// The strip's filled button is the app's ONLY play/pause, and it is in the dock — so it is reachable from
		// /queue, where `shiftTo` has just left this phone, without navigating back. The old probe clicked
		// `[aria-label="play/pause"]`, a label nothing carries any more (world/selectors.ts).
		await phone.locator(SEL.npPlayPause).click();
		await phone.waitForTimeout(700);
		const paused = await awaitMaster(tv);
		expect(paused.paused, `paused=${paused.paused}, currentTime=${paused.currentTime.toFixed(2)}`).toBe(true);

		await phone.locator(SEL.npPlayPause).click();
		await phone.waitForTimeout(1200);
		const resumed = await awaitMaster(tv);
		expect(
			(resumed.decoded ?? 0) - (paused.decoded ?? 0),
			`resume must keep decoding: decoded ${paused.decoded} → ${resumed.decoded}`
		).toBeGreaterThan(0);
		expect(resumed.paused, `paused after resume=${resumed.paused}`).toBe(false);

		const after = await readTap(tv);
		expect(
			after.ok && matches(after.partials, expectedHz(2)),
			`the pitch must survive pause/resume: before pause top=[${top3(before)}] after resume top=[${top3(after)}]`
		).toBe(true);
	} finally {
		await worker.stop();
	}
});

test('a song change resets the shift and the fresh song still decodes', async ({ world }) => {
	// TWO tracks, because the advance needs somewhere to go. The old probe degraded this to an environment
	// limit when the fixture library held only one processable song; world/seed.ts always seeds four.
	const { worker, phone, tv } = await stage(world, [TRACKS.caroline, TRACKS.believin]);
	try {
		expect((await shiftTo(phone, 2)).value).toBe(2);
		// Skip is in the dock too, so `shiftTo` has already put this phone somewhere it can be pressed.
		await phone.getByRole(SEL.skip.role, { name: SEL.skip.name }).click();
		// The reset is a server broadcast, so poll the label rather than dwelling on a guess.
		await expect
			.poll(async () => readKeyLabel(phone), {
				timeout: 10_000,
				message: 'the server must reset keyShift to 0 when the rotation advances'
			})
			.toBe('Key');

		// Graphs detached and none rebuilt at 0, so the fresh song must decode natively.
		const a = await awaitMaster(tv);
		await tv.waitForTimeout(1800);
		const b = await awaitMaster(tv);
		expect(
			(b.decoded ?? 0) - (a.decoded ?? 0),
			`audio must keep decoding on the fresh song after a shifted one: decoded ${a.decoded} → ${b.decoded}`
		).toBeGreaterThan(0);

		const hook = await readGraphState(tv);
		expect(
			hook?.contextStates.every((s) => s === 'closed' || s === 'running'),
			`ctx states: ${JSON.stringify(hook?.contextStates ?? [])} — expect the shifted song's ctx to be 'closed'`
		).toBe(true);
	} finally {
		await worker.stop();
	}
});

// NOT PORTED — and it is no longer the environment limit it was. The old probe recorded
// "the 'sounding key' line renders when a real songProfile is present" as an ENV finding, because the old fake
// worker published a legacy-shape songProfile that `setSongProfile` discarded (keyTonic came back null), so
// `keySounding` was null and `.key-head` never rendered. world/workers.ts now publishes a CORRECT profile
// (keyTonic 9, keyMode minor, a MIDI range), so the line IS reachable and the claim is measurable for the
// first time. Asserting it would be a NEW claim rather than a ported one, so it is left here as the next
// thing to add, not silently folded into the tests above.
