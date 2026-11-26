// Ready for tonight's facts (proposal 39), from live state only: the seat, the TV's last `tv:audio`, the workers'
// notes and profiles, the speed page's own numbers and the media volume's free space. No new storage. The rows are
// `$lib/ready.ts`'s. See docs/SERVER.md#ready-for-tonight.
import { statfsSync } from 'node:fs';
import type { EncoreApp } from './app';
import { READY_TIMEOUT_MS, RECHECK_EVERY_MS, type ReadyFacts } from '../ready';
import { readySongs, speed } from './jobs/metrics';
import { librarySizes } from './media/library-manage';
import { mediaRoot } from './media/paths';
import { retentionCapBytes } from './media/retention';

/** The speed page's window, so the two pages say the same pace. */
const SPEED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Fewer songs than this and a typical pace is a guess, so the row says none. */
const SPEED_MIN_SONGS = 3;
/** A song's size when the library has none to measure: a 4 min song with its stems, a little over. */
const DEFAULT_SONG_BYTES = 60e6;

let recheckAt: number | null = null;

/** Resolves to `fallback` when `work` takes longer than READY_TIMEOUT_MS, so no row can hang the page. */
async function bounded<T>(work: () => Promise<T>, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<T>((r) => (timer = setTimeout(() => r(fallback), READY_TIMEOUT_MS)));
	try {
		return await Promise.race([work().catch(() => fallback), late]);
	} finally {
		clearTimeout(timer);
	}
}

/** How many more songs fit: what is free (under the library cap, when one is set) ÷ the library's median song. */
async function roomForSongs(app: EncoreApp): Promise<number | null> {
	const ready = app.media.listReady();
	const cap = retentionCapBytes();
	const sizes = await librarySizes(ready, app.mediaStore, cap);
	const bytes = Object.values(sizes.songs)
		.map((s) => s.bytes)
		.filter((b) => b > 0)
		.sort((a, b) => a - b);
	const median = bytes.length ? bytes[Math.floor(bytes.length / 2)]! : DEFAULT_SONG_BYTES;
	const disk = statfsSync(mediaRoot());
	let free = disk.bavail * disk.bsize;
	if (cap !== null) free = Math.min(free, Math.max(0, cap - sizes.totalBytes));
	return Math.floor(free / median);
}

function typicalMinutes(app: EncoreApp): number | null {
	const since = app.now() - SPEED_WINDOW_MS;
	const s = speed(readySongs(app.attempts.finishedSince(since, 2_000), since).songs);
	if (s.n < SPEED_MIN_SONGS || s.p50Multiple === null || s.p50AudioSec === null) return null;
	return (s.p50Multiple * s.p50AudioSec) / 60;
}

export async function readyFacts(app: EncoreApp): Promise<ReadyFacts> {
	const tv = app.screens?.list().find((s) => s.isTv);
	return {
		now: app.now(),
		tvName: tv?.name ?? null,
		audio: app.screens?.audio() ?? null,
		workers: app.workerHub.workers().map((w) => ({
			capabilities: w.capabilities,
			...(w.profile?.device ? { device: w.profile.device } : {}),
			notes: w.warnings ?? [],
			...(w.lyricsAt !== undefined ? { lyricsAt: w.lyricsAt } : {})
		})),
		canMake: app.workerHub.canMake(),
		typicalMinutes: typicalMinutes(app),
		recheckAt,
		roomForSongs: await bounded(() => roomForSongs(app), null)
	};
}

/** Check again: every worker runs its lyrics check. Refused (false) within RECHECK_EVERY_MS of the last one. */
export function recheck(app: EncoreApp): boolean {
	const now = app.now();
	if (recheckAt !== null && now - recheckAt < RECHECK_EVERY_MS) return false;
	recheckAt = now;
	app.workerHub.recheck();
	return true;
}

/** For tests: forget the last recheck. */
export function resetReadyForTests(): void {
	recheckAt = null;
}
