// "Your songs" and "Download my data", both read for one owner only. See docs/SERVER.md#your-songs.

import type { EncoreApp } from '../app';
import type { Media } from '../../contract';
import type { HistoryOwner } from '../nights/repository';

export interface YourSong {
	/** The song in the library now, or null for a save whose song has gone. */
	mediaId: string | null;
	title: string;
	artist: string | null;
	sung: number;
	lastSungAt: number | null;
	/** From your last finished turn of it; 0 and null when there is none. */
	keyShift: number;
	guideLevel: number | null;
	saved: { id: string; savedAt: number } | null;
}

const origin = (source: string, sourceRef: string) => `${source}\u0000${sourceRef}`;

/** Sung and saved, one row per song, most used first and then most recent. Keyed on the song's origin, so a save
 *  finds its song again when it is made again under a new id. */
export function yourSongs(app: EncoreApp, owner: HistoryOwner): YourSong[] {
	const byOrigin = new Map<string, Media>();
	for (const m of app.mediaById.values()) byOrigin.set(origin(m.source, m.sourceRef), m);
	const songs = new Map<string, YourSong & { lastAt: number }>();
	const blank = (m: Media | undefined, title: string, artist: string | null) => ({
		mediaId: m?.id ?? null,
		title: m?.title ?? title,
		artist: m ? (m.artist ?? null) : artist,
		sung: 0,
		lastSungAt: null,
		keyShift: 0,
		guideLevel: null,
		saved: null,
		lastAt: 0
	});
	for (const t of app.nights.turnsFor(owner)) {
		const media = app.mediaById.get(t.mediaId);
		// shortcut: a sung song whose media row is gone drops out; PR 3's "needs making" covers saves only.
		if (!media) continue;
		const key = origin(media.source, media.sourceRef);
		const song = songs.get(key) ?? blank(media, media.title, null);
		song.sung++;
		song.lastSungAt = t.endedAt;
		song.lastAt = Math.max(song.lastAt, t.endedAt);
		if (t.end === 'finished') {
			song.keyShift = t.keyShift;
			song.guideLevel = t.guideLevel;
		}
		songs.set(key, song);
	}
	for (const s of app.savedSongs.listFor(owner)) {
		const key = origin(s.source, s.sourceRef);
		const song = songs.get(key) ?? blank(byOrigin.get(key), s.title, s.artist);
		song.saved = { id: s.id, savedAt: s.savedAt };
		song.lastAt = Math.max(song.lastAt, s.savedAt);
		songs.set(key, song);
	}
	const uses = (s: YourSong) => s.sung + (s.saved ? 1 : 0);
	return [...songs.values()]
		.sort((a, b) => uses(b) - uses(a) || b.lastAt - a.lastAt)
		.map(({ lastAt: _lastAt, ...song }) => song);
}

/** Everything Encore keeps about the caller, with no token or hash: name and colour, phones (kept only), saves and
 *  turns. */
export function exportFor(app: EncoreApp, owner: HistoryOwner, me: { displayName: string; color: string }) {
	const person = owner.personId ? app.people.byId(owner.personId) : null;
	const turns = app.nights.turnsFor(owner);
	return {
		exportedAt: new Date(app.now()).toISOString(),
		name: person?.displayName ?? me.displayName,
		color: person?.color ?? me.color,
		kept: person !== null,
		phones: owner.personId ? app.people.devicesOf(owner.personId) : [],
		savedSongs: app.savedSongs.listFor(owner).map((s) => ({
			title: s.title,
			artist: s.artist,
			source: s.source,
			sourceRef: s.sourceRef,
			savedAt: s.savedAt
		})),
		// Fields listed one by one, so no internal id (a night's, a turn's, a song's) reaches the file.
		nights: app.nights.nightsFor(owner).map((n) => ({
			startedAt: n.startedAt,
			endedAt: n.endedAt,
			songs: n.songs,
			turns: turns
				.filter((t) => t.nightId === n.id)
				.map((t) => ({
					title: app.mediaById.get(t.mediaId)?.title ?? null,
					startedAt: t.startedAt,
					endedAt: t.endedAt,
					end: t.end,
					keyShift: t.keyShift,
					keyChanges: t.keyChanges,
					guideLevel: t.guideLevel,
					cheers: t.cheers
				}))
		}))
	};
}
