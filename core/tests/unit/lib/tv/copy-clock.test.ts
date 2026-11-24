import { expect, it } from 'bun:test';
import { read } from '$test';
import {
	CLOCK_STALE_MS,
	ClockOffset,
	MAX_SEEK_LEAD_SEC,
	MAX_TRIM,
	SEEK_OVER_SEC,
	TRIM_OVER_SEC,
	followPlan,
	nextSeekLead,
	tvPositionAt,
	untrim,
	untrimWhenStale
} from '$lib/tv/copy-clock';

it('ClockOffset keeps the minimum-RTT sample of the last 8', () => {
	const c = new ClockOffset();
	expect(c.offsetMs).toBeNull();
	// rtt 40, offset 1000 - (0 + 20) = 980
	c.add(0, 1000, 40);
	// rtt 10, offset 2000 - (1000 + 5) = 995: the least-queued sample wins
	c.add(1000, 2000, 1010);
	c.add(2000, 3100, 2200);
	expect(c.offsetMs).toBe(995);
	// Eight more slow samples push the fast one out of the window.
	for (let i = 0; i < 8; i++) c.add(10_000 + i, 20_000, 10_100 + i);
	expect(c.offsetMs).toBe(20_000 - (10_000 + 50));
});

it('ClockOffset ignores a negative or non-finite round trip', () => {
	const c = new ClockOffset();
	c.add(100, 1000, 50);
	c.add(Number.NaN, 1000, 50);
	expect(c.offsetMs).toBeNull();
});

it("tvPositionAt extrapolates the TV's report to now on core's clock", () => {
	// Reported at core 10_000 as 5 s; now is 9_500 here with an offset of +1_000, i.e. core 10_500.
	expect(tvPositionAt({ entryId: 'e', positionSec: 5, serverAt: 10_000 }, 1_000, 9_500)).toBeCloseTo(5.5, 9);
});

it('followPlan leaves a small error alone, trims a middle one and seeks a large one', () => {
	expect(followPlan(10 + TRIM_OVER_SEC / 2, 10)).toEqual({ kind: 'rate', rate: 1 });
	const ahead = followPlan(10.06, 10);
	const behind = followPlan(9.94, 10);
	expect(ahead.kind === 'rate' && ahead.rate).toBeCloseTo(1 - 0.03, 9);
	expect(behind.kind === 'rate' && behind.rate).toBeCloseTo(1 + 0.03, 9);
	expect(followPlan(10 + SEEK_OVER_SEC + 0.01, 10)).toEqual({ kind: 'seek', toSec: 10 });
	expect(followPlan(0, 0.5, 0.04)).toEqual({ kind: 'seek', toSec: 0.54 });
});

it('followPlan never trims past MAX_TRIM and holds on a non-finite playhead', () => {
	for (const e of [0.021, 0.05, 0.09]) {
		const p = followPlan(10 + e, 10);
		expect(p.kind).toBe('rate');
		if (p.kind === 'rate') expect(Math.abs(p.rate - 1)).toBeLessThanOrEqual(MAX_TRIM + 1e-12);
	}
	expect(followPlan(Number.NaN, 10)).toEqual({ kind: 'rate', rate: 1 });
});

it('nextSeekLead learns from a late landing, within bounds', () => {
	expect(nextSeekLead(0, -0.05)).toBeCloseTo(0.05, 9);
	expect(nextSeekLead(0.05, 0.02)).toBeCloseTo(0.03, 9);
	expect(nextSeekLead(0, 0.2)).toBe(0);
	expect(nextSeekLead(0.2, -1)).toBe(MAX_SEEK_LEAD_SEC);
	expect(nextSeekLead(0.1, Number.NaN)).toBe(0.1);
});

// The seat's own element is the room's clock: only a copy is handed `follow`, and without it the rate goes back to 1.
it('only a copy follows, and a slot without `follow` runs at rate 1', () => {
	const code = (path: string) =>
		read(path)
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/.*$/gm, '');
	const page = code('src/routes/tv/+page.svelte');
	expect(page).toContain('const follow = $derived(isCopy && tvClock');
	expect(page).toContain('follow={follow}');
	const player = code('src/lib/tv/TvPlayer.svelte');
	expect(player).toMatch(/if \(!f\) \{\s*untrim\(el\);/);
	// A copy that stops following (another entry, paused, seeking) drops its trim at once.
	expect(player).toMatch(/if \(!following \|\| resumeTarget !== undefined\) \{\s*untrim\(el\);\s*return;/);
	// A trim is held only until the clock goes stale; the effect's cleanup (the next frame) cancels that.
	expect(player).toContain('return untrimWhenStale(el);');
	// The first of two seek votes keeps the current trim for one frame, so it is held to the same stale timer.
	expect(player).toContain('if (++followSeekVotes < 2) return untrimWhenStale(el);');
	// Every path that keeps a trim arms it: the rate branch and the first seek vote, and nothing else returns early.
	expect(player.match(/return untrimWhenStale\(el\);/g)?.length).toBe(2);
	// The one trim site; every other write is a reset through `untrim`.
	expect(player.match(/playbackRate =/g)?.length).toBe(1);
});

function fakeTimer() {
	const t = { run: null as (() => void) | null, ms: 0, cleared: false };
	const set = (run: () => void, ms: number) => {
		t.run = run;
		t.ms = ms;
		return 7 as unknown as ReturnType<typeof setTimeout>;
	};
	const clear = (id: ReturnType<typeof setTimeout>) => {
		if ((id as unknown) === 7) t.cleared = true;
	};
	return { t, set, clear };
}

it('a trim goes back to 1 once no frame has come for CLOCK_STALE_MS', () => {
	const el = { playbackRate: 1.03 };
	const { t, set, clear } = fakeTimer();
	untrimWhenStale(el, set, clear);
	expect(t.ms).toBe(CLOCK_STALE_MS);
	expect(CLOCK_STALE_MS).toBeLessThanOrEqual(1000);
	t.run!();
	expect(el.playbackRate).toBe(1);
});

it('the next frame cancels the reset, so a live clock keeps its trim', () => {
	const el = { playbackRate: 0.97 };
	const { t, set, clear } = fakeTimer();
	const cancel = untrimWhenStale(el, set, clear);
	cancel();
	expect(t.cleared).toBe(true);
	expect(el.playbackRate).toBe(0.97);
});

it('untrim leaves a rate of 1 untouched', () => {
	let writes = 0;
	const el = {
		get playbackRate() {
			return 1;
		},
		set playbackRate(_v: number) {
			writes++;
		}
	};
	untrim(el);
	expect(writes).toBe(0);
});
