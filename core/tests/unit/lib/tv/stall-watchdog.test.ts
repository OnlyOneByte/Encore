// "The song isn't moving": the TV's one rule for a song that won't play (proposal 11). Clock-free, so every case is a
// sequence of readings at chosen times.
import { describe, expect, test } from 'bun:test';
import { read } from '$test';
import {
	StallWatchdog,
	STALL_FAIL_MS,
	STALL_RETRY_MS,
	READY_SETTLE_MS,
	unansweredPlayIsAutoplay,
	type StallReading,
	type UnansweredPlay
} from '$lib/tv/stall-watchdog';

describe('unansweredPlayIsAutoplay: when a pending play() is the tap screen’s case', () => {
	// A play() pending 4 s, its media ready long enough to have answered, on an untouched TV, no error: only the policy.
	const policy: UnansweredPlay = {
		pendingForMs: STALL_RETRY_MS,
		gestured: false,
		readyForMs: READY_SETTLE_MS,
		errored: false
	};
	test('ready media whose play() has gone unanswered for 4 s on an untouched TV is the autoplay policy', () => {
		expect(unansweredPlayIsAutoplay(policy)).toBe(true);
		expect(unansweredPlayIsAutoplay({ ...policy, pendingForMs: 60_000, readyForMs: 60_000 })).toBe(true);
	});
	test('a file that never loads (nothing arrived, no error) is the song’s stall, not the tap screen', () => {
		// Code review r2 of #994, R2-H1: readyState 0 with a fetch open held "Tap anywhere" up for good.
		expect(unansweredPlayIsAutoplay({ ...policy, pendingForMs: 60_000, readyForMs: null })).toBe(false);
	});
	test('a slow cold start: the file just landed, so its play() has not had time to answer (#1267)', () => {
		// The play() was asked for 6 s ago, but the media only became ready this tick, or just under 1 s ago.
		expect(unansweredPlayIsAutoplay({ ...policy, pendingForMs: 6_000, readyForMs: 0 })).toBe(false);
		expect(unansweredPlayIsAutoplay({ ...policy, pendingForMs: 6_000, readyForMs: READY_SETTLE_MS - 1 })).toBe(false);
		expect(unansweredPlayIsAutoplay({ ...policy, pendingForMs: 6_000, readyForMs: READY_SETTLE_MS })).toBe(true);
	});
	test('a refused autoplay on a 6 s cold file reaches the tap screen before the 8 s failure (review of #1280)', () => {
		// The file lands at 6 s; one second later the still-pending play() is the policy, a full second before 8 s.
		const landsAt = 6_000;
		const hintAt = landsAt + READY_SETTLE_MS;
		expect(unansweredPlayIsAutoplay({ ...policy, pendingForMs: hintAt, readyForMs: hintAt - landsAt })).toBe(true);
		expect(hintAt).toBeLessThan(STALL_FAIL_MS);
	});
	test('a media error is the song’s, whatever its play() is doing', () => {
		expect(unansweredPlayIsAutoplay({ ...policy, errored: true })).toBe(false);
	});
	test('not before 4 s, not when nothing is pending, not on a TV someone has touched', () => {
		expect(unansweredPlayIsAutoplay({ ...policy, pendingForMs: STALL_RETRY_MS - 1 })).toBe(false);
		expect(unansweredPlayIsAutoplay({ ...policy, pendingForMs: null })).toBe(false);
		expect(unansweredPlayIsAutoplay({ ...policy, gestured: true })).toBe(false);
	});
});

const at = (now: number, over: Partial<StallReading> = {}): StallReading => ({
	now,
	position: 0,
	watching: true,
	waitingForTap: false,
	errored: false,
	...over
});

/** Ticks every 250 ms from `from` to `to` with the playhead held at `position`; returns every non-`none` action. */
function run(w: StallWatchdog, from: number, to: number, over: Partial<StallReading> = {}): [number, string][] {
	const out: [number, string][] = [];
	for (let t = from; t <= to; t += 250) {
		const a = w.tick(at(t, over));
		if (a !== 'none') out.push([t, a]);
	}
	return out;
}

describe('StallWatchdog', () => {
	test('a song that never moves is retried once at 4 s and failed at 8 s', () => {
		expect(run(new StallWatchdog(), 0, 20_000)).toEqual([
			[STALL_RETRY_MS, 'retry'],
			[STALL_FAIL_MS, 'fail']
		]);
	});

	test('a song that moves is never touched', () => {
		const w = new StallWatchdog();
		for (let t = 0; t <= 60_000; t += 250) expect(w.tick(at(t, { position: t / 1000 }))).toBe('none');
	});

	test('a stall MID-SONG counts from the moment the playhead stopped', () => {
		const w = new StallWatchdog();
		for (let t = 0; t <= 30_000; t += 250) w.tick(at(t, { position: t / 1000 }));
		expect(run(w, 30_250, 50_000, { position: 30 })).toEqual([
			[30_000 + STALL_RETRY_MS, 'retry'],
			[30_000 + STALL_FAIL_MS, 'fail']
		]);
	});

	test('a media error fails at once, without waiting for the retry', () => {
		expect(new StallWatchdog().tick(at(0, { errored: true }))).toBe('fail');
	});

	test('never while paused from a phone: the time paused does not count', () => {
		const w = new StallWatchdog();
		expect(run(w, 0, 3_000)).toEqual([]);
		expect(run(w, 3_250, 60_000, { watching: false })).toEqual([]);
		// Resumed: a fresh 4 s before the retry, not the 3 s already spent.
		expect(run(w, 60_250, 64_500)).toEqual([[60_250 + STALL_RETRY_MS, 'retry']]);
	});

	test('never while the TV waits for a tap to start sound, error or not', () => {
		const w = new StallWatchdog();
		expect(run(w, 0, 120_000, { waitingForTap: true })).toEqual([]);
		expect(run(w, 120_250, 130_000, { waitingForTap: true, errored: true })).toEqual([]);
	});

	test('the retry is quiet about its own reload: 0 and back to the stuck spot are not the song moving', () => {
		const w = new StallWatchdog();
		for (let t = 0; t <= 10_000; t += 250) w.tick(at(t, { position: t / 1000 }));
		run(w, 10_250, 13_750, { position: 10 });
		expect(w.tick(at(10_000 + STALL_RETRY_MS, { position: 10 }))).toBe('retry');
		// The reload drops the playhead to 0, then the resume puts it back; still stuck, so it fails on time.
		expect(w.tick(at(14_250, { position: 0 }))).toBe('none');
		expect(run(w, 14_500, 20_000, { position: 10 })).toEqual([[10_000 + STALL_FAIL_MS, 'fail']]);
	});

	test('the resume landing a hair past the stuck spot is not the song moving: it still fails at 8 s', () => {
		// Measured in the probe: the seek back landed just past where the song stuck, and the stall ran to ~13 s.
		const w = new StallWatchdog();
		expect(run(w, 0, 4_000, { position: 1.023 })).toEqual([[STALL_RETRY_MS, 'retry']]);
		w.tick(at(4_250, { position: 0 }));
		expect(run(w, 4_500, 12_000, { position: 1.042 })).toEqual([[STALL_FAIL_MS, 'fail']]);
	});

	test('a retry that works: once past the stuck spot the song is playing again', () => {
		const w = new StallWatchdog();
		run(w, 0, 4_000, { position: 5 });
		expect(run(w, 4_250, 30_000, { position: 5 })).toContainEqual([8_000, 'fail']);
		const ok = new StallWatchdog();
		run(ok, 0, 4_000, { position: 5 });
		for (let t = 4_250; t <= 30_000; t += 250)
			expect(ok.tick(at(t, { position: 5 + (t - 4_000) / 1000 }))).toBe('none');
	});

	test('one retry per song: a second stall later in the same song fails without another', () => {
		const w = new StallWatchdog();
		run(w, 0, 4_000, { position: 5 });
		for (let t = 4_250; t <= 20_000; t += 250) w.tick(at(t, { position: 5 + (t - 4_000) / 1000 }));
		expect(run(w, 20_250, 40_000, { position: 21 })).toEqual([[20_000 + STALL_FAIL_MS, 'fail']]);
	});

	test('a seek the room asked for rebases: the restart is not the song sticking', () => {
		const w = new StallWatchdog();
		for (let t = 0; t <= 4_000; t += 250) w.tick(at(t, { position: 60 }));
		w.rebase();
		// Restarted to 0 and playing forward from there.
		for (let t = 4_250; t <= 20_000; t += 250) expect(w.tick(at(t, { position: (t - 4_250) / 1000 }))).toBe('none');
	});

	test('fails once, and a new song (reset) gets its own retry and failure', () => {
		const w = new StallWatchdog();
		expect(run(w, 0, 20_000).filter(([, a]) => a === 'fail')).toHaveLength(1);
		w.reset();
		expect(run(w, 20_250, 40_000)).toEqual([
			[20_250 + STALL_RETRY_MS, 'retry'],
			[20_250 + STALL_FAIL_MS, 'fail']
		]);
	});
});

describe('StallWatchdog: time nobody watched, slow loads, seeks (code review of #994)', () => {
	test('a TV that froze or slept for 10 s re-bases on wake instead of failing the song at once', () => {
		const w = new StallWatchdog();
		for (let t = 0; t <= 2_000; t += 250) w.tick(at(t, { position: t / 1000 }));
		expect(w.tick(at(12_000, { position: 2 }))).toBe('none');
		// Still stuck after waking: the 10 s nobody watched is forgiven, less one normal tick that does count.
		const since = 2_000 + (12_000 - 2_000 - 250);
		expect(run(w, 12_250, 22_000, { position: 2 })).toEqual([
			[since + STALL_RETRY_MS, 'retry'],
			[since + STALL_FAIL_MS, 'fail']
		]);
	});

	test('ticks just over 1 s apart (a throttled background tab) still fail a stuck song, they do not hold it forever', () => {
		// Code review r2 of #994: dropping the whole count on every gap meant 1001 ms ticks never failed anything.
		const w = new StallWatchdog();
		const acts: [number, string][] = [];
		for (let t = 0; t <= 120_000; t += 1_001) {
			const a = w.tick(at(t));
			if (a !== 'none') acts.push([t, a]);
		}
		expect(acts.map(([, a]) => a)).toEqual(['retry', 'fail']);
		// Each throttled tick counts as one normal tick of stillness: 8 s of them is 32 ticks.
		expect(acts[1]![0]).toBe((STALL_FAIL_MS / 250) * 1_001);
	});

	test('a slow first load still downloading at 4 s is not reloaded, and still fails at 8 s if it never starts', () => {
		expect(run(new StallWatchdog(), 0, 10_000, { downloading: true })).toEqual([[STALL_FAIL_MS, 'fail']]);
	});

	test('the reload waits for 4 s of stillness after the last byte, then runs once', () => {
		const w = new StallWatchdog();
		expect(run(w, 0, 1_000, { downloading: true })).toEqual([]);
		expect(run(w, 1_250, 6_000)).toEqual([[5_000, 'retry']]);
	});

	test('a slow first load that lands after 4 s is not reloaded the moment it lands: it gets until 8 s to start', () => {
		// #1116: the reload one tick after a 5 s download threw the file away, the refetch took 5 s more, and a song
		// about to play failed at 8 s.
		const w = new StallWatchdog();
		expect(run(w, 0, 5_000, { downloading: true })).toEqual([]);
		expect(run(w, 5_250, 7_750)).toEqual([]);
		expect(run(w, 8_000, 9_000)).toEqual([[STALL_FAIL_MS, 'fail']]);
		const started = new StallWatchdog();
		run(started, 0, 5_000, { downloading: true });
		for (let t = 5_250; t <= 20_000; t += 250)
			expect(started.tick(at(t, { position: (t - 5_250) / 1000 }))).toBe('none');
	});

	test('a phone seek after the retry, back to or below the stuck spot, is not a stall', () => {
		const w = new StallWatchdog();
		expect(run(w, 0, 4_000, { position: 30 })).toEqual([[STALL_RETRY_MS, 'retry']]);
		w.rebase(); // applySeek, for a seek the room asked for
		for (let t = 4_250; t <= 20_000; t += 250)
			expect(w.tick(at(t, { position: 10 + (t - 4_250) / 1000 }))).toBe('none');
	});
});

describe('TvPlayer wiring', () => {
	// SOURCE PINS, a tripwire and nothing more. The behaviour is checked by probe/wont-play.spec.ts in a real browser: a
	// refactor that breaks a pin is fixed by re-running that probe, never by editing the string to match.
	const src = read('src/lib/tv/TvPlayer.svelte');

	test('the unanswered-play() clock is per song, and a play() that succeeds clears the latch it raised', () => {
		// Code review r4 of #994: an earlier song's pending play() (its AbortError not settled yet) started the next
		// song's 4 s early, and a latch the clock raised stayed up after a later play() worked.
		const play = src.split('async function tryPlayMaster(): Promise<void> {')[1]?.split('\n\t}\n')[0] ?? '';
		expect(play).toContain('if (playPendingSince === null || playPendingFor !== entryId) {');
		expect(play).toMatch(/await master\.play\(\);\s+blockedUnanswered = false;/);
	});

	test("#974's guard stays: a rejection for a src the slot has left is nobody's failure", () => {
		expect(src).toContain("if (master?.getAttribute('src') !== requestedSrc) return;");
	});

	test('only NotAllowedError arms "Tap anywhere"; every other rejection is left to the watchdog', () => {
		const catchBody = src.split('} catch (err: unknown) {')[1]?.split('\n\t}\n')[0] ?? '';
		expect(catchBody.match(/autoplayBlocked = true/g)).toHaveLength(1);
		expect(catchBody).toContain("if (name === 'NotAllowedError') {");
		expect(catchBody).not.toContain('master.paused');
		// A tap already SPENT on a song that still will not start hands it to the watchdog (UI review of #994, D2).
		const otherBranch = catchBody.split('} else {')[1] ?? '';
		expect(otherBranch).toMatch(/if \(autoplayBlocked\) \{\s+autoplayBlocked = false;/);
	});

	test('the watchdog watches only the playing slot, pauses for a tap, and reads the element error', () => {
		const tick = src.split('function checkStall(): void {')[1]?.split('\n\t}\n')[0] ?? '';
		expect(tick).toContain("watching: !!el && transport === 'play' && !el.ended");
		expect(tick).toContain('errored: !!el?.error');
	});

	test('each new entry resets the slot’s watchdog, and a seek the room asks for rebases it', () => {
		// Reset on a CHANGE of id only: a room update re-reads the prop for the same entry and must not restart the count.
		expect(src).toMatch(/if \(entryId === watchedEntryId\) return;\s+watchedEntryId = entryId;\s+watchdog\.reset\(\);/);
		const seek = src.split('function applySeek(')[1]?.split('\n\t}\n')[0] ?? '';
		expect(seek).toContain('watchdog.rebase();');
	});

	test('an unanswered play() is judged by unansweredPlayIsAutoplay, and the latch it raises precedes the tick', () => {
		const tick = src.split('function checkStall(): void {')[1]?.split('\n\t}\n')[0] ?? '';
		expect(tick).toContain('unansweredPlayIsAutoplay({');
		// Ready time is stamped on the tick that first sees HAVE_FUTURE_DATA and cleared when it drops (#1267).
		expect(tick).toContain('el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) readySince ??= now;');
		expect(tick).toContain('readyForMs: readySince === null ? null : now - readySince');
		expect(tick).toContain('errored: !!el.error');
		// The latch is raised BEFORE the tick, so the watchdog sees the tap wait at the same 4 s it would retry at.
		expect(tick.indexOf('autoplayBlocked = true;')).toBeLessThan(tick.indexOf('watchdog.tick('));
		// An open fetch with nothing arrived yet is a slow load, not a hiccup: the retry must not restart it.
		expect(tick).toContain('el.networkState === HTMLMediaElement.NETWORK_LOADING');
	});

	test('a hidden slot reports its pre-warm dead only while it holds that song’s own file (#1265 review M1)', () => {
		// A guide-mix song's src waits on its mix, so until it lands the element's error is the previous file's;
		// `idle` is exactly "this slot does not hold this entry's file".
		const tick = src.split('function checkStall(): void {')[1]?.split('\n\t}\n')[0] ?? '';
		expect(tick).toContain("if (!active && transport !== 'idle' && el?.error && !prewarmFailedFired) {");
	});

	test('one way out: no per-event error callback beside onfailed', () => {
		// The element's own error event only asks the watchdog, so there is still ONE decision and one way out.
		expect(src.match(/\bonerror=\{[^}]*\}/g)).toEqual(['onerror={() => checkStall()}']);
		expect(src).not.toContain('onplaybackfailed');
	});
});
