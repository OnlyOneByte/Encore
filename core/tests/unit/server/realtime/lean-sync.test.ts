// queue:sync carries the QUEUED songs' media, not the library, and the TV's loudness levels as numbers. The size
// guard and the audio proof live together because they are the two halves of one change: the rows left, and the
// one thing the TV derived from them stayed.
import { test, expect } from 'bun:test';
import { syncEvent, mediaFor } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import { EMPTY_SONG_PROFILE, type Media, type QueueEntry } from '$lib/contract';
import { loudnessNormalizationGain, LOUDNESS_MEASURED_FLOOR } from '$lib/contract/lyrics/loudness-normalization';

const song = (id: string, loudnessLufs: number | null | undefined): Media => ({
	id,
	source: 'youtube',
	sourceRef: id,
	title: `title ${id}`,
	durationSec: 180,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: `derived/stems/${id}/instrumental.flac`,
	// `undefined` is a song with no profile at all (a search hit); `null` a profile with nothing measured.
	...(loudnessLufs === undefined ? {} : { songProfile: { ...EMPTY_SONG_PROFILE, loudnessLufs } })
});

function room(catalog: Media[], queued: string[]) {
	const state = new AuthoritativeState();
	queued.forEach((mediaId, i) => {
		const entry: QueueEntry = {
			id: `e${i}`,
			mediaId,
			singerId: 's1',
			status: 'queued',
			rotationSeq: -1,
			addedAt: i + 1
		};
		state.applyQueueOp({ op: 'add', entry });
	});
	return { state, mediaById: new Map(catalog.map((m) => [m.id, m])) };
}

/** Main's TV derivation, VERBATIM from `routes/tv/+page.svelte` before this change: it ran over the TV's catalog,
 *  which was every row the full sync carried, i.e. the server's whole `mediaById`. */
const mainTvLevels = (catalog: Iterable<Media>) =>
	[...catalog].map((m) => m.songProfile?.loudnessLufs ?? null).filter((v): v is number => typeof v === 'number');

test('queue:sync size does not scale with the library: 3 queued + 3,000 rows is under 50 KB and carries exactly the 3', () => {
	const catalog = Array.from({ length: 3000 }, (_, i) => song(`m${i}`, i % 3 === 0 ? -14 + (i % 7) : null));
	const { state, mediaById } = room(catalog, ['m10', 'm2000', 'm2999']);
	const sync = syncEvent(state, { mediaById });
	expect(sync.media?.map((m) => m.id).sort()).toEqual(['m10', 'm2000', 'm2999']);
	expect(JSON.stringify(sync).length).toBeLessThan(50_000);
});

test('mediaFor returns each queued song once, and skips an id the box does not hold', () => {
	const { state, mediaById } = room([song('a', -14), song('b', -12)], ['a', 'a', 'gone', 'b']);
	expect(mediaFor(state.entries, { mediaById }).map((m) => m.id)).toEqual(['a', 'b']);
});

test('AUDIO: the TV gain from sync.loudness is identical to the gain main derived from the whole catalog', () => {
	// Measured, unmeasured (null), no profile at all, a loud outlier that main attenuated, and only one of each queued,
	// so the lean sync's media cannot be where the levels came from.
	const catalog = [
		...Array.from({ length: 12 }, (_, i) => song(`m${i}`, -16 + i * 0.5)),
		song('loud', -3),
		song('quiet', -30),
		song('unmeasured', null),
		song('hit', undefined)
	];
	const { state, mediaById } = room(catalog, ['loud', 'unmeasured']);
	const sync = syncEvent(state, { mediaById });

	expect(sync.loudness).toEqual(mainTvLevels(mediaById.values()));
	let attenuated = 0;
	for (const m of catalog)
		for (const enabled of [true, false]) {
			const songLufs = m.songProfile?.loudnessLufs ?? null;
			const before = loudnessNormalizationGain({ songLufs, libraryLevels: mainTvLevels(catalog), enabled });
			const after = loudnessNormalizationGain({ songLufs, libraryLevels: sync.loudness!, enabled });
			expect(after).toEqual(before);
			if (after.attenuated) attenuated++;
		}
	// The proof is about a gain that MOVES, not only unity: the outlier really is pulled down, on both paths.
	expect(attenuated).toBe(1);
});

test('AUDIO: under the measured floor both paths stay at unity, with the same count', () => {
	// One short of the floor, `loud` included: a level the server dropped or added would change the count.
	const catalog = [
		...Array.from({ length: LOUDNESS_MEASURED_FLOOR - 2 }, (_, i) => song(`m${i}`, -14 - i)),
		song('loud', 0)
	];
	const { state, mediaById } = room(catalog, ['m0']);
	const sync = syncEvent(state, { mediaById });
	const input = { songLufs: 0, enabled: true };
	const before = loudnessNormalizationGain({ ...input, libraryLevels: mainTvLevels(catalog) });
	expect(loudnessNormalizationGain({ ...input, libraryLevels: sync.loudness! })).toEqual(before);
	expect(before.gain).toBe(1);
	expect(before.measuredCount).toBe(LOUDNESS_MEASURED_FLOOR - 1);
});
