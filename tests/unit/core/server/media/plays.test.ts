// Play tracking — the recency signal retention's LRU eviction needs. Before this,
// `library.lastPlayedAt` existed in the sidecar but nothing incremented it, so eviction fell back to
// `addedAt`: a song added months ago and sung weekly would be dropped before one added yesterday and
// never played. Exactly backwards.
import { expect, it } from 'bun:test';
import { PlayTracker, bumpPlay } from '$lib/server/media/plays';

const entry = (id: string, mediaId: string) => ({ id, mediaId });

function harness() {
	const plays: Array<{ mediaId: string; entryId: string }> = [];
	const tracker = new PlayTracker((mediaId, entryId) => plays.push({ mediaId, entryId }));
	return { plays, tracker };
}

it('PlayTracker: records a play when a song starts', () => {
	const { plays, tracker } = harness();
	tracker.onNowPlaying(entry('e1', 'm1'));
	expect(plays).toEqual([{ mediaId: 'm1', entryId: 'e1' }]);
});

it('PlayTracker: does NOT double-count a re-emitted nowplaying', () => {
	// This is the reason the tracker exists rather than counting at the call site: nowplaying is
	// re-broadcast without a change whenever a cook finishes, so the TV preloads the ready song.
	// Counting every emit would inflate the CURRENT song's plays each time an unrelated song cooked.
	const { plays, tracker } = harness();
	tracker.onNowPlaying(entry('e1', 'm1'));
	tracker.onNowPlaying(entry('e1', 'm1'));
	tracker.onNowPlaying(entry('e1', 'm1'));
	expect(plays).toHaveLength(1);
});

it('PlayTracker: counts each song as the room advances', () => {
	const { plays, tracker } = harness();
	tracker.onNowPlaying(entry('e1', 'm1'));
	tracker.onNowPlaying(entry('e2', 'm2'));
	tracker.onNowPlaying(entry('e3', 'm1')); // same SONG, different entry — a real second play
	expect(plays.map((p) => p.mediaId)).toEqual(['m1', 'm2', 'm1']);
});

it('PlayTracker: dedupes on ENTRY, so the same song queued twice counts twice', () => {
	// Deduping on mediaId would silently under-count a crowd favourite sung by two people.
	const { plays, tracker } = harness();
	tracker.onNowPlaying(entry('e1', 'popular'));
	tracker.onNowPlaying(entry('e2', 'popular'));
	expect(plays).toHaveLength(2);
});

it('PlayTracker: nothing-playing records no play, and clears so a restart counts again', () => {
	const { plays, tracker } = harness();
	tracker.onNowPlaying(entry('e1', 'm1'));
	tracker.onNowPlaying(null); // queue drained
	expect(plays).toHaveLength(1);
	expect(tracker.lastCountedEntryId()).toBeNull();

	tracker.onNowPlaying(entry('e1', 'm1')); // same entry restarted — a fresh play, not a dupe
	expect(plays).toHaveLength(2);
});

it('PlayTracker: an idle room emitting repeatedly records nothing', () => {
	const { plays, tracker } = harness();
	tracker.onNowPlaying(null);
	tracker.onNowPlaying(null);
	expect(plays).toEqual([]);
});

it('bumpPlay: increments the count and stamps the time', () => {
	expect(bumpPlay({ playCount: 0, lastPlayedAt: null }, 1000)).toEqual({ playCount: 1, lastPlayedAt: 1000 });
	expect(bumpPlay({ playCount: 6, lastPlayedAt: 500 }, 1000)).toEqual({ playCount: 7, lastPlayedAt: 1000 });
});

it('the LRU signal this feeds: a frequently-played old song now outranks a never-played new one', async () => {
	// The concrete regression: planEviction sorts by lastUsedAt. With addedAt as the only signal the
	// old song lost; with lastPlayedAt populated it wins.
	const { planEviction } = await import('$lib/server/media/retention');
	const oldButLoved = { mediaId: 'loved', derivedBytes: 100, lastUsedAt: 9_000 }; // played recently
	const newButIgnored = { mediaId: 'ignored', derivedBytes: 100, lastUsedAt: 1_000 }; // added later, never played
	expect(planEviction([oldButLoved, newButIgnored], 100)).toEqual(['ignored']);
});
