// The playhead must not be yanked backwards by a `canplay` arriving AFTER a playback command, on an element that was
// ALREADY MOUNTED when the command landed.
//
// Behavioural and driven through reactive props, both load-bearing: the defect lives entirely in the WIRING between the
// `playback:state` seek effect and the master's `oncanplay`, so every pure-function test of `resumeSeekTarget`/`seekPlan`
// stays green while the room jumps. And it is specifically the WARM path — mounting with `seekSec` already set does NOT
// reproduce it, because at first-effect time the element is cold, the held target is legitimately taken and the mount's
// own `canplay` consumes it, so the command must arrive after the element exists (`makeReactive`).
//
// Stashing `resumeTarget` unconditionally is the trap: `canplay` fires every time `readyState` rises back to
// HAVE_FUTURE_DATA, so after any seek that empties the buffer and after every underrun recovery. With `applySeek`
// declining a sub-threshold target and not clearing the stash, the target stays armed at the last command's playhead and
// the next decode hiccup applies it — an audible rewind. Every playback command re-arms it, and the guide slider re-arms
// it ~8x/second while dragging, which is what makes one deterministic bug look like random pausing and unpausing.
import { test, expect, afterEach } from 'bun:test';
import { mount, unmount, flushSync } from '$setup/svelte-client';
import TvPlayer from '$lib/tv/TvPlayer.svelte';
import { makeReactive } from './playback-common-actions.harness.svelte.js';

// happy-dom's own Event: bun defines its own global, and happy-dom's dispatchEvent rejects an event that
// is not an instance of ITS classes.
const win = (globalThis as unknown as { window: Window & typeof globalThis }).window;

let live: Array<{ comp: unknown; host: HTMLElement }> = [];
afterEach(() => {
	for (const { comp, host } of live) {
		void unmount(comp as never);
		host.remove();
	}
	live = [];
});

// `__snapshot` is the brand the slot's `PlaybackSnapshot` type carries; the component needs only enough
// for `isPlayable` to pass and a src to resolve.
const SNAP = {
	id: 'm1',
	title: 'Sweet Caroline',
	artist: 'Neil Diamond',
	instrumentalRef: 'audio/sweet.wav',
	stemStatus: 'ready',
	__snapshot: true
} as unknown as Record<string, unknown>;

/**
 * A live, playing slot with NO commanded position, so the seek effect early-returns and nothing is held from the mount.
 * The element exists on return, which is the warm path's precondition.
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
	// The element is mounted, so this is the warm path and applySeek moves it.
	command(props, 30);
	expect(audio.currentTime).toBeCloseTo(30, 3);

	audio.currentTime = 90;

	// An underrun recovery, or a seek's buffer refilling, fires `canplay` on the same element.
	canplay(audio);
	expect(audio.currentTime).toBeCloseTo(90, 3);
});

test('a canplay after a SUB-THRESHOLD command does not rewind — the real-world shape', () => {
	const { props, audio } = mountWarm();
	audio.currentTime = 60;
	// A pause, a key press or a guide nudge. The broadcast `positionSec` is LIVE telemetry, so it lands
	// within SEEK_JUMP_SEC (1.5s) of where the song already is and applySeek correctly declines it — the
	// stash must not stay armed.
	command(props, 60.4);
	expect(audio.currentTime).toBeCloseTo(60, 3);

	audio.currentTime = 180;
	canplay(audio);
	// Armed, this snaps back to 60.4: a two-minute rewind from one pause tap.
	expect(audio.currentTime).toBeCloseTo(180, 3);
});

test('repeated canplays stay inert — the stash is never armed on the warm path at all', () => {
	const { props, audio } = mountWarm();
	command(props, 30);

	// `applyResume` consumes a target after applying it, so a single-fire test can pass by accident:
	// firing repeatedly across an advancing playhead proves nothing is armed at all.
	for (const t of [45, 60, 75]) {
		audio.currentTime = t;
		canplay(audio);
		expect(audio.currentTime).toBeCloseTo(t, 3);
	}
});

test('the COLD-MOUNT resume still works — the fix does not regress what the stash is for', () => {
	// The case the hold exists for: a reload mid-song. `playback:state` arrives while there is NO element
	// — the <audio> is gated on the `nowplaying:changed` the server sends one frame later — so the
	// position is held and taken on the first `canplay`. Modelled by commanding with `media: null`.
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

	command(props, 42);

	props.media = SNAP;
	flushSync();
	const audio = host.querySelector('audio') as HTMLMediaElement;
	expect(audio, 'the master <audio> did not render').toBeTruthy();

	// The buffer primes: the held position is taken here.
	canplay(audio);
	expect(audio.currentTime).toBeCloseTo(42, 3);
});
