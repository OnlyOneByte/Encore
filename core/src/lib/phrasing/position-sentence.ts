/**
 * The guest's own place in the rotation, stated in words. AN ETA IS A CLAIM, and a wrong one in a shared room is
 * witnessed by everybody in it: the wait is a sum over the entries ahead, and A SUM WITH AN UNKNOWN TERM IS UNKNOWN, so
 * every builder here omits the clause rather than zeroing or guessing it. It FORMATS at this boundary, before any value
 * reaches a template.
 */

/** Below this many seconds the wait is stated as a phrase, never as a rounded-to-zero number. */
const SUB_MINUTE_SEC = 45;

export interface PositionInput {
	/** 1-based place among the QUEUED entries — 1 means the guest is next. */
	place: number;
	/** Display name of the singer immediately ahead of the guest, or `null` when there is none (the guest is next) or
	 * the roster does not resolve them. */
	beforeName?: string | null;
	/** Seconds still to run on the song playing NOW: 0 when nothing is playing, `null` when something is
	 * playing whose length is unknown. `null` makes the whole wait unknown. */
	nowRemainingSec?: number | null;
	/** Lengths of the entries AHEAD, in rotation order. `null` for an entry whose media is not in the catalog,
	 * which is the real unknown-duration path. */
	aheadDurationsSec?: Array<number | null>;
	/** Can the guest's own pick play when its turn arrives? A still-processing song is skipped by the TV, so
	 * claiming "you're up next" for one contradicts the queue's own badge. */
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

/** English ordinal for a positive integer. THE TEENS are the whole reason this is a function: 11, 12 and 13 take "th"
 * even though 1, 2 and 3 do not, and a naive modulo-ten version ships "11st" the first time a party gets big enough. */
export function ordinalWord(n: number): string {
	const i = Math.trunc(n);
	const tens = Math.abs(i) % 100;
	const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][Math.abs(i) % 10] ?? 'th');
	return `${i}${suffix}`;
}

/** The wait clause, or `null` when it cannot be known honestly — see `waitSeconds`. */
export function waitWords(nowRemainingSec: number | null, aheadDurationsSec: Array<number | null>): string | null {
	const total = waitSeconds(nowRemainingSec, aheadDurationsSec);
	if (total === null) return null;
	if (total < SUB_MINUTE_SEC) return 'Less than a minute.';
	const minutes = Math.round(total / 60);
	return `Roughly ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/** The same wait as a BYLINE FRAGMENT rather than a sentence, because it sits mid-line after a separator and a
 * capitalised sentence there reads as two sentences welded together. A SECOND FORMATTER, NEVER A SECOND SUM: both
 * spellings call `waitSeconds`, so they cannot disagree about how long the wait is. */
export function waitShort(nowRemainingSec: number | null, aheadDurationsSec: Array<number | null>): string | null {
	const total = waitSeconds(nowRemainingSec, aheadDurationsSec);
	if (total === null) return null;
	if (total < SUB_MINUTE_SEC) return '<1 min';
	return `~${Math.round(total / 60)} min`;
}

/** The wait in seconds, or `null` — the one place the sum and its unknown rule live, so every formatter above agrees
 * on both. Unknown when the playing song's remaining time is unknown, or when ANY entry ahead has no resolvable length:
 * a partial sum UNDERSTATES the wait, and a guest who wanders off is worse than one who waits. */
function waitSeconds(nowRemainingSec: number | null, aheadDurationsSec: Array<number | null>): number | null {
	if (nowRemainingSec === null || !Number.isFinite(nowRemainingSec)) return null;
	let total = Math.max(0, nowRemainingSec);
	for (const d of aheadDurationsSec) {
		if (d === null || !Number.isFinite(d)) return null;
		total += Math.max(0, d);
	}
	return total;
}

/** The guest's position as words, or `null` when they have nothing queued (place < 1) — the caller renders no card at
 * all rather than an empty one. */
export function positionWords(input: PositionInput): PositionWords | null {
	const { place, beforeName = null, nowRemainingSec = 0, aheadDurationsSec = [], playable = true } = input;
	if (!Number.isFinite(place) || place < 1) return null;

	const wait = waitWords(nowRemainingSec, aheadDurationsSec);
	let lead: string;
	if (place === 1) {
		// "Up next" is a claim about PLAYABILITY, not position: a still-processing song is skipped.
		lead = playable ? "You're up next." : "You're next once it's ready.";
	} else if (beforeName) {
		lead = `You're up after ${beforeName}.`;
	} else {
		// No resolvable name for the singer ahead: still say what is true rather than inventing one.
		lead = "You're up after the song ahead of you.";
	}
	return { ordinal: ordinalWord(place), lead, wait };
}
