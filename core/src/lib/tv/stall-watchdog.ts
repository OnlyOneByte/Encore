// THE ONE RULE FOR A SONG THAT WON'T PLAY: "the song isn't moving". A media error, a play() that rejects and leaves
// the element paused, and a file that stalls mid-song all look the same from here — the room means to play and the
// playhead does not move — so one timer covers all three, and the TV moves on instead of sitting over a silent room.
// See docs/FRONTEND.md#a-song-that-wont-play.

/** Still this long while the room means to play, and the TV reloads the source and asks once more: a wifi hiccup. */
export const STALL_RETRY_MS = 4000;
/** Still this long, and the song has failed. A cold load on the LAN measures ~740 ms, so this is over ten times that. */
export const STALL_FAIL_MS = 8000;
/** How often the player reads the playhead. Fine enough that "8 s" means 8 s, cheap enough to run all night. */
export const STALL_TICK_MS = 250;
/** A seek lands NEAR its target, not on it, so the retry's resume can land a few ms past the stuck spot. A playing
 *  song clears this in a couple of ticks; a stuck one never does. */
const RESUME_SLACK_SEC = 0.5;
/** A gap between two readings longer than this is time nobody watched (a frozen tab, a TV out of standby), not a stall:
 *  four missed ticks. */
const STALL_GAP_MS = 1000;

export type StallAction = 'none' | 'retry' | 'fail';

export interface StallReading {
	now: number;
	/** The element's `currentTime`. READ ONLY: nothing here moves the playhead. */
	position: number;
	/** The room means THIS slot to be playing: active, on screen, not paused from a phone, holding its src, not ended. */
	watching: boolean;
	/** Autoplay was refused and a tap would lift it. That is the whole TV's problem, not this song's, and skipping
	 *  there would burn every turn in the queue, so it never counts. */
	waitingForTap: boolean;
	/** The element holds a media error (a missing or corrupt file), which no amount of waiting fixes. */
	errored: boolean;
	/** Bytes arrived since the last reading. A slow first load is not a hiccup: reloading it throws the buffer away, so
	 *  the retry waits while it downloads and the 8 s failure still stands. */
	downloading?: boolean;
}

/** One per player slot, reset per ENTRY. Pure and clock-free: the caller passes `now`, so a test needs no timers. */
export class StallWatchdog {
	/** When the playhead last moved, or when watching began. `null` while not watching, so a pause never counts. */
	#since: number | null = null;
	#at = 0;
	// After the retry: the stuck position (plus the slack). The reload drops the playhead to 0 and the resume puts it
	// back, and neither is the song moving, so only a position PAST this one counts until it is passed.
	#floor = -Infinity;
	#retried = false;
	#failed = false;
	#lastTick: number | null = null;

	/** A new song: one fresh retry, one fresh failure. */
	reset(): void {
		this.rebase();
		this.#retried = false;
		this.#failed = false;
	}

	/** The room moved the playhead itself (a seek or a restart from a phone): count from here. */
	rebase(): void {
		this.#since = null;
		this.#floor = -Infinity;
	}

	tick({ now, position, watching, waitingForTap, errored, downloading = false }: StallReading): StallAction {
		if (this.#failed) return 'none';
		const prev = this.#lastTick;
		this.#lastTick = now;
		// Forgive the time nobody watched, and ONLY that: dropping the whole count let ticks just over 1 s apart (a
		// throttled background tab) hold a stuck song forever. A normal tick's worth of each gap still counts.
		if (prev !== null && now - prev > STALL_GAP_MS && this.#since !== null) this.#since += now - prev - STALL_TICK_MS;
		if (!watching || waitingForTap) {
			this.#since = null;
			return 'none';
		}
		if (errored) return this.#fail();
		const moved = position !== this.#at && position > this.#floor;
		if (this.#since === null || moved) {
			this.#since = now;
			this.#at = position;
			if (moved) this.#floor = -Infinity;
			return 'none';
		}
		const still = now - this.#since;
		if (still >= STALL_FAIL_MS) return this.#fail();
		if (still >= STALL_RETRY_MS && !this.#retried && !downloading) {
			this.#retried = true;
			this.#floor = this.#at + RESUME_SLACK_SEC;
			return 'retry';
		}
		return 'none';
	}

	#fail(): StallAction {
		this.#failed = true;
		return 'fail';
	}
}

/** `HTMLMediaElement.HAVE_FUTURE_DATA`, spelled here so this file stays free of the DOM and testable under bun. */
const HAVE_FUTURE_DATA = 3;

export interface UnansweredPlay {
	/** How long the slot's play() has gone unanswered, or null when none is pending. */
	pendingForMs: number | null;
	/** Has anyone touched this TV? A TV that had a tap is not being held by its autoplay policy. */
	gestured: boolean;
	/** The element's `readyState`. */
	readyState: number;
	/** The element holds a media error. */
	errored: boolean;
}

/**
 * Is an unanswered play() the AUTOPLAY POLICY holding the song (show "Tap anywhere"), rather than the song itself?
 * Some TV browsers are said to leave a refused play() pending instead of rejecting it with NotAllowedError, and read as
 * "the song isn't moving" that would fail every song in the queue. But a play() also stays pending while the bytes
 * simply do not come, with nothing loaded and no error, and calling THAT the tap screen's case hid a real stall
 * forever (code review r2 of #994). So only media that is READY to play, on an untouched TV, after the retry's 4 s:
 * then nothing but the policy can be holding it back. A media error is the song's, whatever its play() is doing.
 */
export function unansweredPlayIsAutoplay({ pendingForMs, gestured, readyState, errored }: UnansweredPlay): boolean {
	return (
		pendingForMs !== null && pendingForMs >= STALL_RETRY_MS && !gestured && !errored && readyState >= HAVE_FUTURE_DATA
	);
}
