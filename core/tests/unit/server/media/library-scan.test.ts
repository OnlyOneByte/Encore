// The local library is now whatever is IN the folder, so these cover the two decisions that scan makes: what a
// filename says about a track, and what to do with a file whose length cannot be read. The second one is the
// one with teeth — a library file indexed at durationSec 0 is a song the wait estimate reports as instant.
import { test, expect } from 'bun:test';
import { scanLibrary, trackNameFromFile } from '$lib/server/media/local';
import { parseFfmpegDuration } from '$lib/server/media/duration';

test('a filename splits on the hyphen convention, and stays all-title without one', () => {
	expect(trackNameFromFile('Neil Diamond - Sweet Caroline.wav')).toEqual({
		artist: 'Neil Diamond',
		title: 'Sweet Caroline'
	});
	// No hyphen: inventing an artist from the only text present would be a guess.
	expect(trackNameFromFile('sweet-caroline.wav')).toEqual({ title: 'sweet-caroline' });
	// The kebab hyphens inside a word are NOT the separator — only a spaced one is.
	expect(trackNameFromFile('livin-on-a-prayer.mp3')).toEqual({ title: 'livin-on-a-prayer' });
	expect(trackNameFromFile('A_B - C_D.m4a')).toEqual({ artist: 'A B', title: 'C D' });
});

test('a file whose duration cannot be read is skipped, never indexed at zero', async () => {
	const files = ['good.wav', 'unreadable.mp4'];
	const { tracks, skipped } = await scanLibrary(files, async (ref) => (ref.endsWith('good.wav') ? 201 : null));

	expect(tracks).toEqual([{ sourceRef: 'library/good.wav', durationSec: 201, title: 'good' }]);
	expect(skipped).toEqual(['unreadable.mp4']);
	// The whole point: nothing reached the index with a zero length.
	expect(tracks.every((t) => t.durationSec > 0)).toBe(true);
});

test('only extensions the media route can serve are considered', async () => {
	const { tracks, skipped } = await scanLibrary(['song.wav', 'notes.txt', 'cover.jpg', 'x.opus'], async () => 10);

	expect(tracks.map((t) => t.sourceRef)).toEqual(['library/song.wav', 'library/x.opus']);
	// A non-media file is not a SKIPPED track — it was never a candidate, so it must not be reported as one.
	expect(skipped).toEqual([]);
});

test('refs are rooted under library/, which is what resolves on disk', async () => {
	const { tracks } = await scanLibrary(['a.wav'], async () => 5);
	expect(tracks[0]!.sourceRef).toBe('library/a.wav');
});

test('ffmpeg duration parsing rounds, and declines what it cannot measure', () => {
	expect(parseFfmpegDuration('  Duration: 00:03:33.76, start: 0.000000, bitrate: 127 kb/s')).toBe(214);
	expect(parseFfmpegDuration('  Duration: 01:00:00.00, start: 0.000000')).toBe(3600);
	// `N/A` is a stream of unknown length. Zero is a container that opened but could not measure. Neither is 0s.
	expect(parseFfmpegDuration('  Duration: N/A, bitrate: N/A')).toBeNull();
	expect(parseFfmpegDuration('  Duration: 00:00:00.00, start: 0.000000')).toBeNull();
	// What ffmpeg prints for the 16-byte stub this fixture used to write.
	expect(parseFfmpegDuration('Error opening input file /tmp/stub.mp4.')).toBeNull();
	expect(parseFfmpegDuration('')).toBeNull();
});
