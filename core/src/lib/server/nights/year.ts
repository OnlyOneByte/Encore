// "This year" for Your year, in the phone's time zone. See docs/SERVER.md#your-night.

/** The IANA zone `tz` if `Intl` knows it, else the core's own. Anything else from the query string is ignored. */
export function zoneOrServer(tz: string | null | undefined): string {
	if (tz && tz.length <= 64) {
		try {
			return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
		} catch {
			// An unknown zone: fall back.
		}
	}
	return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The wall-clock fields of instant `t` in `tz`. */
function wall(t: number, tz: string) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		hourCycle: 'h23',
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric',
		second: 'numeric'
	}).formatToParts(t);
	const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
	return {
		year: get('year'),
		utc: Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
	};
}

/** The instant midnight on Jan 1 of `year` happens in `tz`. */
function newYear(year: number, tz: string): number {
	const guess = Date.UTC(year, 0, 1);
	// The zone's offset at the guess, then again at the result, in case the guess sat across an offset change.
	let t = guess - (wall(guess, tz).utc - guess);
	t = guess - (wall(t, tz).utc - t);
	return t;
}

/** The calendar year `now` falls in, in `tz`, as `[from, to)` instants. */
export function yearIn(now: number, tz: string): { year: number; from: number; to: number } {
	const year = wall(now, tz).year;
	return { year, from: newYear(year, tz), to: newYear(year + 1, tz) };
}
