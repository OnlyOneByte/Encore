// Ready for tonight (proposal 39): the six rows the host checks before guests arrive. Shared by the route that
// computes them and the page that draws them, so the two agree on every word. See docs/SERVER.md#ready-for-tonight.

export type ReadyRowId = 'tv' | 'sound' | 'maker' | 'youtube' | 'lyrics' | 'room';

/** `amber`: works, but slow. `wait`: asked, not answered yet. Only `green` says a check passed. */
export type ReadyState = 'green' | 'amber' | 'red' | 'wait';

/** The next move a red row offers on the page. */
export type ReadyAction = 'tv-link' | 'test-sound' | 'library';

export interface ReadyRow {
	id: ReadyRowId;
	label: string;
	state: ReadyState;
	status: string;
	/** Only on red or amber: the one thing to do. */
	fix?: string;
	/** The technical line behind "Details", on red rows only. */
	detail?: string;
	action?: ReadyAction;
}

export const READY_LABELS: Record<ReadyRowId, string> = {
	tv: 'TV',
	sound: 'TV sound',
	maker: 'Karaoke maker',
	youtube: 'YouTube',
	lyrics: 'Lyrics',
	room: 'Room for songs'
};

/** A check that has not answered by then reads red, never green. */
export const READY_TIMEOUT_MS = 2_000;
/** The recheck's rate limit. */
export const RECHECK_EVERY_MS = 5_000;
/** Above this many minutes a song, the maker row is amber: it works, but slowly. */
export const SLOW_MINUTES = 5;
/** Below this many songs of room, the room row is red. */
export const ALMOST_FULL_SONGS = 10;

export interface ReadyWorker {
	capabilities: string[];
	device?: string;
	notes: { code: string; text: string; detail?: string }[];
	/** When its lyrics check last answered; undefined while the first one runs. */
	lyricsAt?: number;
}

/** Every fact the six rows read, gathered by the route. Nothing here names a host, a path or a secret. */
export interface ReadyFacts {
	now: number;
	/** The room's TV's name, when it is open and holds the seat. */
	tvName: string | null;
	audio: 'ok' | 'locked' | null;
	workers: ReadyWorker[];
	/** Whether the fleet can make a song at the room's quality (`WorkerHub.canMake`). */
	canMake: boolean;
	/** The typical pick-to-ready on this box, in minutes, when enough songs were made to say. */
	typicalMinutes: number | null;
	/** When the host last tapped Check again. */
	recheckAt: number | null;
	/** Songs that fit in what is free; null when the room could not be measured in time. */
	roomForSongs: number | null;
}

const row = (id: ReadyRowId, state: ReadyState, status: string, more: Partial<ReadyRow> = {}): ReadyRow => ({
	id,
	label: READY_LABELS[id],
	state,
	status,
	...more
});

const NO_MAKER = { fix: 'Start the karaoke maker.' };

export function readyRows(f: ReadyFacts): ReadyRow[] {
	const notes = f.workers.flatMap((w) => w.notes);
	const note = (code: string) => notes.find((n) => n.code === code);
	const noWorker = f.workers.length === 0;

	const tv = f.tvName
		? row('tv', 'green', `${f.tvName} is on and holding the room`)
		: row('tv', 'red', 'No TV is open', { fix: 'Open the TV link on the big screen.', action: 'tv-link' });

	const sound = !f.tvName
		? row('sound', 'red', 'No TV to play on', { fix: 'Open the TV first.', action: 'tv-link' })
		: f.audio === 'ok'
			? row('sound', 'green', 'Sound is on')
			: f.audio === 'locked'
				? row('sound', 'red', 'The TV needs one tap before it can play sound', {
						fix: 'Tap the TV screen once.',
						action: 'test-sound'
					})
				: row('sound', 'wait', 'Not checked yet', { fix: 'Play a test sound on the TV.', action: 'test-sound' });

	const device = f.workers.find((w) => w.device)?.device ?? 'cpu';
	const pace = f.typicalMinutes === null ? '' : ` · about ${Math.max(1, Math.round(f.typicalMinutes))} min a song`;
	const empty = note('no-capabilities');
	const maker = noWorker
		? row('maker', 'red', 'Not connected', NO_MAKER)
		: !f.canMake
			? row('maker', 'red', "Connected, but it can't make karaoke", {
					fix: 'Check the karaoke maker’s setup.',
					...(empty ? { detail: empty.text } : {})
				})
			: f.typicalMinutes !== null && f.typicalMinutes > SLOW_MINUTES
				? row('maker', 'amber', `Ready · ${device}${pace}`, { fix: 'Songs take a while: pick early.' })
				: row('maker', 'green', `Ready · ${device}${pace}`);

	const gap = note('youtube-gap');
	const youtube = noWorker
		? row('youtube', 'red', 'Needs the karaoke maker', NO_MAKER)
		: gap
			? row('youtube', 'red', 'YouTube downloads will fail', {
					fix: `The karaoke maker is missing ${gap.text.replace(/^YouTube downloads will fail without /, '')}.`,
					detail: gap.text
				})
			: f.workers.some((w) => w.capabilities.includes('fetch:ytdlp'))
				? row('youtube', 'green', 'Downloads work')
				: row('youtube', 'red', "The karaoke maker can't download", {
						fix: 'Install yt-dlp where the karaoke maker runs.'
					});

	const lost = note('lyrics-unreachable');
	// Green only once a check answered AFTER the host's last tap: an older answer is not this check's.
	const answered = f.workers.filter(
		(w) => w.lyricsAt !== undefined && (f.recheckAt === null || w.lyricsAt >= f.recheckAt)
	);
	const lyrics = noWorker
		? row('lyrics', 'red', 'Needs the karaoke maker', NO_MAKER)
		: lost
			? row('lyrics', 'red', "Can't reach the lyrics service", {
					fix: "Songs will use heard words, which are less accurate and slower. Check this box's internet.",
					detail: lost.detail
				})
			: answered.length > 0
				? row('lyrics', 'green', 'Lyrics lookups work')
				: f.recheckAt !== null && f.now - f.recheckAt > READY_TIMEOUT_MS
					? row('lyrics', 'red', "Didn't answer", {
							fix: 'Tap Check again. If it stays red, restart the karaoke maker.'
						})
					: row('lyrics', 'wait', 'Checking…');

	const room =
		f.roomForSongs === null
			? row('room', 'red', "Didn't answer", { fix: 'Tap Check again.' })
			: f.roomForSongs < ALMOST_FULL_SONGS
				? row('room', 'red', `Almost full: room for ${f.roomForSongs} more`, {
						fix: 'Clear space in Library.',
						action: 'library'
					})
				: row('room', 'green', `Room for about ${f.roomForSongs} more songs`);

	return [tv, sound, maker, youtube, lyrics, room];
}
