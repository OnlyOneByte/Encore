// P13 — TAP TO START, the one route out of a silent television. A document-wide pointerdown/keydown listener
// plus the full-screen card are the ONLY path from a fresh TV that was refused autoplay to audible sound, and
// every reading here is anchored to the decoded byte counter rather than to `paused`
// (docs/E2E.md#proving-audio).
//
// A SYNTHETIC CLICK CANNOT DO THIS. `el.click()` is untrusted, grants no user activation and fires no
// `pointerdown` at all, so it reaches TvPlayer's window listener never. Only real input — `page.mouse` — can,
// which is why the tap below is a mouse click and not an `evaluate`.
//
// WHY THE REFUSAL IS INJECTED, and why that is not a weaker test than a browser flag.
// The probe's subject is the state a television sits in: `play()` rejected with NotAllowedError, the element
// holding its preload burst, the room silent. THIS CHROMIUM WILL NOT PRODUCE THAT STATE. Measured on this box
// (headless chromium-1223, macOS): with NO flag, with `--autoplay-policy=user-gesture-required` and with
// `--autoplay-policy=document-user-activation-required`, a fresh /tv autoplayed every time — `paused false`,
// currentTime climbing, no `.autoplay-hint`. On top of that, `navigator.userActivation.hasBeenActive` is true
// within ~271ms of a cold load with nothing touching the page, and Playwright issues every `evaluate` with CDP
// `userGesture: true` — so merely READING the page grants the frame sticky activation.
//
// So the policy is re-imposed IN-PAGE by `world/autoplay.ts`: an unmuted `play()` rejects with the exact
// NotAllowedError Chromium raises until a TRUSTED `pointerdown`/`keydown` arrives. That leaves the product's
// whole path under test — the rejection handler that latches `autoplayBlocked`, the card the page renders from
// it, the window listener, the `play()` retry inside the gesture's own task, and the recovery that retracts the
// card. What it does NOT claim is that this browser refuses; each test below therefore asserts
// `autoplayIsBlocked` as an explicit PREMISE first, so a broken shim can never read as a pass. The alternative,
// `--autoplay-policy=no-user-gesture-required`, is the forbidden direction: it would prove playback in an
// environment no television is ever in (docs/E2E.md#autoplay).
//
// Ported from tests/e2e/probes/p13-tap-to-start.mjs.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import { autoplayIsBlocked, requireActivationForPlayback } from '../../world/autoplay';
import { awaitMaster, readMaster, readStage, singTrack, TRACKS, type MediaRow } from './audio-probe-support';

/** A room with one processed song queued and a TV that has been refused autoplay and NOT touched. */
async function silentTelevision(world: import('../../world/fixtures').World) {
	const worker = await startFakeWorker(world);
	const phone = await world.openPhone('Singer13');
	await openBrowseFromHome(phone);
	const media = await singTrack(phone, world.baseURL, TRACKS.caroline);
	// The old probe's first check — "a singer can join and queue the processed song" — asserted through its
	// waits: a `.qrow`, or the band naming the song once the server auto-started it. A PLAYING entry renders
	// no `.qrow` at all, so the band's title is the reading that covers both.
	await expect(
		phone.locator(SEL.bandTitle),
		'the phone never showed the queued song in its now-playing band'
	).toHaveText(new RegExp(media.title, 'i'));

	const tv = await world.openTv();
	// The init script takes effect on the NEXT document, so the reload is what puts the refusal in front of the
	// app's first play() attempt.
	await requireActivationForPlayback(tv);
	await tv.reload();
	// THE PREMISE, asserted before anything reads the app's reaction to it: if the shim were not in force, every
	// assertion below would pass or fail for a reason that has nothing to do with the product.
	expect(
		await autoplayIsBlocked(tv),
		'world/autoplay.ts is not in force on this page, so nothing below is measuring a refused television'
	).toBe(true);
	const master = await awaitMaster(tv);
	return { worker, phone, tv, media, master };
}

test('the tap-to-start card is up before any gesture', async ({ world }) => {
	const { worker, tv } = await silentTelevision(world);
	try {
		// Polled rather than read once: the card is rendered from the rejection, which lands a frame or two
		// after the element mounts.
		await expect
			.poll(async () => (await readStage(tv)).autoplayHint, {
				message:
					`${SEL.autoplayHint} never rendered on a TV that was refused autoplay. It is the tap-to-start ` +
					`affordance — without it there is no route out of silence.`
			})
			.toBe(true);
	} finally {
		await worker.stop();
	}
});

test('the master is stalled at the preload floor before any gesture', async ({ world }) => {
	const { worker, tv } = await silentTelevision(world);
	try {
		// The card is the page's own acknowledgement that play() was refused; measure the element only once it
		// is up, or this races the refusal rather than reading its result.
		await expect.poll(async () => (await readStage(tv)).autoplayHint).toBe(true);
		// THE PRELOAD FLOOR IS A SETTLING STATE, so wait for the element to reach it rather than reading the
		// half-loaded moment: `readyState 4` (HAVE_ENOUGH_DATA) is the floor's own definition, reached ~500ms
		// after mount on this box. It is NOT a stand-in for the decoded-byte assertion below — a readyState-4
		// element with zero decoded bytes is precisely the defect this probe family exists for.
		await expect
			.poll(async () => (await readMaster(tv))?.readyState ?? -1, {
				message: 'the refused element never finished buffering, so there is no preload floor to measure'
			})
			.toBe(4);
		const master = await awaitMaster(tv);
		const detail = `master=${JSON.stringify(master)} — gestureless it must NOT be playing`;
		expect(master.paused, `paused: ${detail}`).toBe(true);
		expect(master.currentTime, `currentTime: ${detail}`).toBe(0);
		// SOME decoded bytes, not none: a refused element still buffers its preload burst, and zero here would
		// mean the file never loaded — a different defect wearing this one's clothes.
		expect(master.decoded, `decoded: ${detail}`).not.toBeNull();
		expect(master.decoded ?? 0, `decoded: ${detail}`).toBeGreaterThan(0);
	} finally {
		await worker.stop();
	}
});

test('a single real tap unblocks autoplay and the decoder runs', async ({ world }) => {
	const { worker, tv } = await silentTelevision(world);
	try {
		await expect.poll(async () => (await readStage(tv)).autoplayHint).toBe(true);
		expect(await autoplayIsBlocked(tv), 'the refusal must still be in force when the tap lands').toBe(true);

		// ONE REAL TAP, at the centre of the 1080p stage. `world/autoplay.ts` only counts a TRUSTED event, so a
		// synthetic click or a dispatched PointerEvent would unblock nothing — which is the property that makes
		// this assertion about the product rather than about the shim.
		await tv.mouse.click(960, 540);
		expect(await autoplayIsBlocked(tv), 'the real tap did not register as activation at all').toBe(false);

		const a = await awaitMaster(tv);
		// A MEASUREMENT INTERVAL, not a workaround: decoded bytes are a RATE, so the claim "the decoder is
		// running" only exists as a difference across a known dwell. 3s is the old probe's own window.
		await tv.waitForTimeout(3000);
		const b = await awaitMaster(tv);

		const dDecoded = (b.decoded ?? 0) - (a.decoded ?? 0);
		const dTime = b.currentTime - a.currentTime;
		expect(
			dDecoded,
			`decoded went ${a.decoded} -> ${b.decoded} (+${dDecoded}) over 3s. Zero means the trusted gesture ` +
				`never reached the document-wide gesture listener — a real TV stays permanently silent.`
		).toBeGreaterThan(0);
		// A SEPARATE claim, and the two disagree in the defect this probe exists for: a FLAC in a <video>
		// advances its playhead while decoding nothing.
		expect(
			dTime,
			`currentTime went ${a.currentTime.toFixed(2)} -> ${b.currentTime.toFixed(2)} (+${dTime.toFixed(2)}s) over 3s`
		).toBeGreaterThan(1.5);
		expect(b.paused, `paused=${b.paused}`).toBe(false);
	} finally {
		await worker.stop();
	}
});

test('the tap-to-start card clears once audio is genuinely playing', async ({ world }) => {
	const { worker, tv } = await silentTelevision(world);
	try {
		await expect.poll(async () => (await readStage(tv)).autoplayHint).toBe(true);
		expect(await autoplayIsBlocked(tv), 'the refusal must still be in force when the tap lands').toBe(true);
		await tv.mouse.click(960, 540);
		// Bounded, because the card is retracted from `onautoplayrecovered` — which fires only after a play()
		// that actually resolved.
		await expect
			.poll(async () => (await readStage(tv)).autoplayHint, {
				message: 'the tap-to-start recovery clears the card only after autoplay actually recovers'
			})
			.toBe(false);
		// …and it cleared because the room has sound, not because the card was dropped on any tap.
		const a: MediaRow = await awaitMaster(tv);
		await tv.waitForTimeout(1500);
		const b: MediaRow = await awaitMaster(tv);
		expect(
			(b.decoded ?? 0) - (a.decoded ?? 0),
			`the card cleared while the decoder stayed flat: decoded ${a.decoded} -> ${b.decoded}`
		).toBeGreaterThan(0);
	} finally {
		await worker.stop();
	}
});
