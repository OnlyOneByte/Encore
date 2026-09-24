/** Format seconds as m:ss, or h:mm:ss past an hour. Clamps negatives to 0 and rounds DOWN, so a fresh song reads
 * 0:00 rather than 0:01 and the elapsed label never shows a second the singer has not heard yet. */
export function formatClock(sec: number): string {
	const t = Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : 0;
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const s = t % 60;
	const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
	return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Time left, as `−2:12`. Rounds UP, so the label only reaches −0:00 when the song is genuinely over rather than
 * sitting there for the last fractional second. */
export function formatRemaining(elapsedSec: number, durationSec: number): string {
	const left = Number.isFinite(durationSec - elapsedSec) ? Math.max(0, durationSec - elapsedSec) : 0;
	return `−${formatClock(Math.ceil(left))}`;
}

/** Elapsed as a 0..1 fraction, or null when it cannot be known. Null rather than 0 for an unknown duration: a bar
 * pinned at zero looks like a stalled song, so the caller hides the row instead of showing a wrong one. Local files
 * and older catalog rows can both arrive with durationSec unset. */
export function progressFraction(elapsedSec: number, durationSec: number): number | null {
	if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
	if (!Number.isFinite(elapsedSec)) return null;
	return Math.min(1, Math.max(0, elapsedSec / durationSec));
}
