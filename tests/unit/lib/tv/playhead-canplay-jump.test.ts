// — the playhead must not be yanked backwards by a `canplay` that arrives after a playback command,
// on an element that was ALREADY MOUNTED when the command landed. This is the regression test for the
// "pausing/unpausing happens frequently and randomly" report.
//
// It is behavioural, and it drives the real effects through reactive props, because both of those
// choices are load-bearing:
//
//   • The defect lived entirely in the WIRING between the `playback:state` seek effect and the
//     master's `oncanplay`, so every pure-function test of `resumeSeekTarget` / `seekPlan` stayed
//     green while the room jumped.
//   • It is specifically the WARM path — a command arriving at a mounted element. Mounting with
//     `seekSec` already set does NOT reproduce it: at first-effect time the element is still cold, so
//     the held target is legitimately taken and consumed by the mount's own `canplay`, and a test
//     written that way passes against the defective code. The command has to arrive AFTER the element
//     exists, which is what `makeReactive` below is for.
//
// THE DEFECT. The seek effect stashed `resumeTarget = target` unconditionally, on the stated premise
// that on the warm path "`canplay` will not fire again". Per the HTML media spec it fires every time
// `readyState` rises back to HAVE_FUTURE_DATA — after any seek that empties the buffer, and after
// every buffer-underrun recovery. `applySeek` declines a sub-threshold target and never cleared the
// stash, so the target stayed armed at the playhead as of the last command; the next decode hiccup
// applied it and the song resumed seconds earlier, flushing the decoder (an audible stop) on the way.
// Every playback command re-armed it, and the guide slider re-arms it ~8x/second while dragging —
// which is what made one deterministic bug look like random pausing and unpausing.
import { test, expect, afterEach } from 'bun:test';
import { mount, unmount, flushSync } from '$setup/svelte-client';
import TvPlayer from '$lib/tv/TvPlayer.svelte';
import { makeReactive } from './playback-common-actions.harness.svelte.js';

// happy-dom's own Event — bun defines its own global and happy-dom's dispatchEvent rejects an event
// that is not an instance of ITS classes (the mount-rung note).
const win = (globalThis as unknown as { window: Window & typeof globalThis }).window;

let live: Array<{ comp: unknown; host: HTMLElement }> = [];
afterEach(() => {
	for (const { comp, host } of live) {
		void unmount(comp as never);
		host.remove();
	}
	live = [];
});

// A minimal playable snapshot. `__snapshot` is the brand the slot's `PlaybackSnapshot` type carries;
// the component only needs enough for `isPlayable` to pass and a src to resolve.
const SNAP = {
	id: 'm1',
	title: 'Sweet Caroline',
	artist: 'Neil Diamond',
	instrumentalRef: 'audio/sweet.wav',
	stemStatus: 'ready',
	__snapshot: true
} as unknown as Record<string, unknown>;

/**
 * Mount a live, playing slot with NO commanded position yet, so the seek effect early-returns on
 * `target === undefined` and nothing is held from the mount. The element exists after this returns,
 * which is the precondition the warm path needs.
 */
function mountWarm(): { props: Record<string, unknown>; audio: HTMLMediaElement } {
	const props = makeReactive({
		media: SNAP,
		entryId: 'e1',
		visible: true,
		active: true,
		playing: true,
		seekSec: undefined,
		seekRev: 0
	}) as Record<string, unknown>;
	const host = document.createElement('div');
	document.body.appendChild(host);
	const comp = mount(TvPlayer as never, { target: host, props });
	flushSync();
	live.push({ comp, host });
	const audio = host.querySelector('audio') as HTMLMediaElement;
	expect(audio, 'the master <audio> did not render').toBeTruthy();
	return { props, audio };
}

/** Deliver a playback command the way `playback:state` does — a position plus a bumped rev. */
function command(props: Record<string, unknown>, positionSec: number): void {
	props.seekSec = positionSec;
	props.seekRev = ((props.seekRev as number) ?? 0) + 1;
	flushSync();
}

/** Fire a real `canplay` at the element, the way a buffer-underrun recovery does. */
function canplay(el: HTMLMediaElement): void {
	el.dispatchEvent(new win.Event('canplay'));
	flushSync();
}

test('a canplay after a JUMP command does not re-apply that command later', () => {
	const { props, audio } = mountWarm();
	// A guest scrubs to 30. The element is mounted, so this is the warm path: applySeek moves it.
	command(props, 30);
	expect(audio.currentTime).toBeCloseTo(30, 3);

	// The song plays on for another minute. Nothing has commanded a new position.
	audio.currentTime = 90;

	// A buffer underrun recovers, or a seek's buffer refills: `canplay` fires on the same element.
	canplay(audio);
	expect(audio.currentTime).toBeCloseTo(90, 3);
});

test('a canplay after a SUB-THRESHOLD command does not rewind — the real-world shape', () => {
	const { props, audio } = mountWarm();
	// The song is a minute in.
	audio.currentTime = 60;
	// A pause/resume, a key press, or a guide nudge. The broadcast `positionSec` is the LIVE telemetry
	// playhead, so it reports a position within SEEK_JUMP_SEC (1.5s) of where the song already is.
	// applySeek correctly declines to move the playhead for it — and used to leave it armed anyway.
	command(props, 60.4);
	expect(audio.currentTime).toBeCloseTo(60, 3);

	// Two more minutes of the song.
	audio.currentTime = 180;
	canplay(audio);
	// Before the fix this snapped back to 60.4 — a two-minute rewind from one pause tap.
	expect(audio.currentTime).toBeCloseTo(180, 3);
});

test('repeated canplays stay inert — the stash is never armed on the warm path at all', () => {
	const { props, audio } = mountWarm();
	command(props, 30);

	// `applyResume` consumes a target after applying it, so a single-fire test could pass on the
	// defective code by accident. Firing repeatedly across an advancing playhead proves nothing is
	// armed in the first place.
	for (const t of [45, 60, 75]) {
		audio.currentTime = t;
		canplay(audio);
		expect(audio.currentTime).toBeCloseTo(t, 3);
	}
});

test('the COLD-MOUNT resume still works — the fix does not regress what the stash is for', () => {
	// The case the hold exists for: a reload mid-song. The room's `playback:state` arrives while there
	// is NO element (on the real TV the <audio> is gated on the `nowplaying:changed` that the server
	// sends one frame later), so the position must be held and taken on the element's first `canplay`.
	// Modelled here by commanding a position with `media: null`, then supplying the media.
	const props = makeReactive({
		media: null,
		entryId: 'e1',
		visible: true,
		active: true,
		playing: true,
		seekSec: undefined,
		seekRev: 0
	}) as Record<string, unknown>;
	const host = document.createElement('div');
	document.body.appendChild(host);
	const comp = mount(TvPlayer as never, { target: host, props });
	flushSync();
	live.push({ comp, host });
	expect(host.querySelector('audio'), 'no element should exist yet').toBeFalsy();

	// The room says "we are 42s into this song" before the element exists.
	command(props, 42);

	// Now the song arrives and the element mounts.
	props.media = SNAP;
	flushSync();
	const audio = host.querySelector('audio') as HTMLMediaElement;
	expect(audio, 'the master <audio> did not render').toBeTruthy();

	// Its buffer primes and it can play: the held position is taken here.
	canplay(audio);
	expect(audio.currentTime).toBeCloseTo(42, 3);
});
