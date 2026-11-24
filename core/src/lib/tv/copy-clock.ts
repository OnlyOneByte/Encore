// How a muted copy follows the TV's clock (`tv:clock`). See docs/FRONTEND.md#a-copy-on-the-tvs-clock.

/** This page's clock, on the same footing as core's `serverNow`. */
export const clientNow = (): number => performance.timeOrigin + performance.now();

/** Under this a copy is left alone; between it and `SEEK_OVER_SEC` it trims its rate; over it, it seeks. */
export const TRIM_OVER_SEC = 0.02;
// Not the proposal's 250 ms: a copy that starts 150 ms late took 5 s of trim to catch up (p95 103 ms at 4x CPU).
export const SEEK_OVER_SEC = 0.1;
/** The most a seek aims ahead of the TV to cover its own landing time. */
export const MAX_SEEK_LEAD_SEC = 0.3;
/** The furthest a trim moves the rate off 1: inaudible on a muted element, invisible on the ball. */
export const MAX_TRIM = 0.03;
/** A trim closes the error over about this long. */
const TRIM_HORIZON_SEC = 2;

const OFFSET_SAMPLES = 8;

/** Core's clock minus this page's, from the minimum-RTT ping of the last 8 (NTP's rule: the least-queued sample). */
export class ClockOffset {
	#samples: { rtt: number; offset: number }[] = [];

	add(t0: number, serverAt: number, t1: number): void {
		const rtt = t1 - t0;
		if (!Number.isFinite(rtt) || rtt < 0) return;
		this.#samples.push({ rtt, offset: serverAt - (t0 + rtt / 2) });
		if (this.#samples.length > OFFSET_SAMPLES) this.#samples.shift();
	}

	/** Null until the first pong. */
	get offsetMs(): number | null {
		if (this.#samples.length === 0) return null;
		return this.#samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
	}
}

export interface TvClock {
	entryId: string;
	positionSec: number;
	/** Core's clock when it received the TV's report. */
	serverAt: number;
}

/** Where the TV's playhead is at `now` (this page's clock), from its last report. */
export function tvPositionAt(clock: TvClock, offsetMs: number, now: number): number {
	return clock.positionSec + (now + offsetMs - clock.serverAt) / 1000;
}

export type FollowPlan = { kind: 'rate'; rate: number } | { kind: 'seek'; toSec: number };

/** What the copy does about its playhead, `copySec`, against the TV's, `tvSec`. A seek aims `leadSec` ahead. */
export function followPlan(copySec: number, tvSec: number, leadSec = 0): FollowPlan {
	const error = copySec - tvSec;
	if (!Number.isFinite(error)) return { kind: 'rate', rate: 1 };
	const size = Math.abs(error);
	if (size > SEEK_OVER_SEC) return { kind: 'seek', toSec: Math.max(0, tvSec + leadSec) };
	if (size < TRIM_OVER_SEC) return { kind: 'rate', rate: 1 };
	// Ahead runs slower, behind runs faster.
	return { kind: 'rate', rate: 1 - Math.sign(error) * Math.min(MAX_TRIM, size / TRIM_HORIZON_SEC) };
}

/** A trim outlives its frame by at most this: past it the seat's socket dropped or frames stopped, and a ±3% rate
 *  left on would drift 30 ms a second. */
export const CLOCK_STALE_MS = 1000;

export function untrim(el: { playbackRate: number }): void {
	if (el.playbackRate !== 1) el.playbackRate = 1;
}

/** Puts the rate back to 1 after `CLOCK_STALE_MS`, unless the returned cancel runs first (the next frame does). */
export function untrimWhenStale(
	el: { playbackRate: number },
	setTimer: (run: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
	clearTimer: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout
): () => void {
	const timer = setTimer(() => untrim(el), CLOCK_STALE_MS);
	return () => clearTimer(timer);
}

/** The next seek's lead, from the error the copy read just after its last seek landed (behind is negative). */
export function nextSeekLead(leadSec: number, errorAfterSeekSec: number): number {
	if (!Number.isFinite(errorAfterSeekSec)) return leadSec;
	return Math.min(MAX_SEEK_LEAD_SEC, Math.max(0, leadSec - errorAfterSeekSec));
}
