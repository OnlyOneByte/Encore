/**
 * The guest's own place in the rotation, stated in words (XR-PH-09).
 *
 * Direction A's core promise is "3rd — you're up after Sam, roughly 11 minutes" rather than a bare
 * ordinal, and the hard half is the minutes clause: an ETA is a CLAIM, and a wrong one in a shared
 * room is witnessed by everybody in it. So the wait is a sum over the entries ahead, and a sum with
 * an unknown term is unknown — this builder omits the clause entirely rather than zeroing or
 * guessing it. That mirrors `progressFraction`'s existing decision to return `null` for an unknown
 * duration instead of 0, taken for the same reason: a bar pinned at zero reads as a stalled song.
 *
 * A pure function, deliberately: the sentence is the requirement, so it is unit-testable with no DOM
 * and no room. It also FORMATS here — at the boundary, before any value reaches a template — so no
 * unrounded float can reach a phone as "roughly 11.033333333333333 minutes".
 */

/** Below this many seconds the wait is stated as a phrase, never as a rounded-to-zero number. */
const SUB_MINUTE_SEC = 45;

export interface PositionInput {
	/** 1-based place among the QUEUED entries — 1 means the guest is next. */
	place: number;
	/**
	 * Display name of the singer immediately ahead of the guest, or `null` when there is none (the
	 * guest is next) or the roster does not resolve them.
	 */
	beforeName?: string | null;
	/**
	 * Seconds still to run on the song playing NOW: `0` when nothing is playing, `null` when
	 * something is playing whose length is unknown. `null` makes the whole wait unknown.
	 */
	nowRemainingSec?: number | null;
	/**
	 * Lengths of the queued entries AHEAD of the guest, in rotation order. `null` for an entry whose
	 * media is not in the catalog — `Media.durationSec` is required, so absence is the real
	 * unknown-duration path, not a missing field.
	 */
	aheadDurationsSec?: Array<number | null>;
	/**
	 * Can the guest's own pick actually play when its turn arrives? A still-processing song is skipped
	 * by the TV, so claiming "you're up next" for one contradicts the queue list's own badge.
	 */
	playable?: boolean;
}

export interface PositionWords {
	/** The ordinal on its own — "3rd" — for the card's lead numeral. */
	ordinal: string;
	/** Who the guest follows: "You're up after Sam." / "You're up next." */
	lead: string;
	/** "Roughly 11 minutes." · "Less than a minute." · `null` when any wait ahead is unknown. */
	wait: string | null;
}

/**
 * English ordinal for a positive integer: 1 → "1st", 11 → "11th", 22 → "22nd", 113 → "113th".
 *
 * The teens are the whole reason this is a function: 11/12/13 take "th" even though 1/2/3 do not,
 * and every naive `n % 10` version ships "11st" the first time a party gets big enough.
 */
export function ordinalWord(n: number): string {
	const i = Math.trunc(n);
	const tens = Math.abs(i) % 100;
	const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][Math.abs(i) % 10] ?? 'th';
	return `${i}${suffix}`;
}

/**
 * The wait clause, or `null` when it cannot be known honestly.
 *
 * Unknown is returned when the playing song's remaining time is unknown, or when ANY entry ahead has
 * no resolvable length — one unknown term makes the sum unknown, and a partial sum understates the
 * wait, which is the failure mode that matters (a guest who wanders off is worse than one who waits).
 */
export function waitWords(nowRemainingSec: number | null, aheadDurationsSec: Array<number | null>): string | null {
	if (nowRemainingSec === null || !Number.isFinite(nowRemainingSec)) return null;
	let total = Math.max(0, nowRemainingSec);
	for (const d of aheadDurationsSec) {
		if (d === null || !Number.isFinite(d)) return null;
		total += Math.max(0, d);
	}
	if (total < SUB_MINUTE_SEC) return 'Less than a minute.';
	const minutes = Math.round(total / 60);
	return `Roughly ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/**
 * The guest's position as words, or `null` when they have nothing queued (place < 1) — the caller
 * renders no card at all rather than an empty one.
 */
export function positionWords(input: PositionInput): PositionWords | null {
	const { place, beforeName = null, nowRemainingSec = 0, aheadDurationsSec = [], playable = true } = input;
	if (!Number.isFinite(place) || place < 1) return null;

	const wait = waitWords(nowRemainingSec, aheadDurationsSec);
	let lead: string;
	if (place === 1) {
		// Only claim "up next" when the song can actually play next. Ranking on position alone said
		// "You're up next!" for a still-processing song the TV skips straight past.
		lead = playable ? "You're up next." : "You're next once it's ready.";
	} else if (beforeName) {
		lead = `You're up after ${beforeName}.`;
	} else {
		// No resolvable name for the singer ahead: still say what is true rather than inventing one.
		lead = "You're up after the song ahead of you.";
	}
	return { ordinal: ordinalWord(place), lead, wait };
}
