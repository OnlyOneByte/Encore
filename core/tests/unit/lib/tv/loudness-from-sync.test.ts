// The TV half of the loudness path, checked per PR: the levels a real server sync carries, adopted the way the TV page
// adopts them, give the TV the same gain main derived from its full catalog. The probe
// `tv-loudness-lean-sync.spec.ts` proves the same end to end, but only nightly.
import { test, expect } from 'bun:test';
import { read, stripComments } from '$test';
import { syncEvent } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import { syncLoudnessLevels } from '$lib/tv/catalog';
import { loudnessNormalizationGain } from '$lib/contract/lyrics/loudness-normalization';
import { EMPTY_SONG_PROFILE, type Media } from '$lib/contract';

const song = (id: string, loudnessLufs: number | null): Media => ({
	id,
	source: 'youtube',
	sourceRef: id,
	title: id,
	durationSec: 180,
	stemStatus: 'ready',
	songProfile: { ...EMPTY_SONG_PROFILE, loudnessLufs }
});

test('the TV pulls the loud outlier down from the sync it receives, though the outlier is the only song queued', () => {
	const catalog = [...Array.from({ length: 9 }, (_, i) => song(`m${i}`, -14)), song('loud', -2), song('raw', null)];
	const state = new AuthoritativeState();
	state.applyQueueOp({
		op: 'add',
		entry: { id: 'e1', mediaId: 'loud', singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: 1 }
	});
	const sync = syncEvent(state, { mediaById: new Map(catalog.map((m) => [m.id, m])) });
	const levels = syncLoudnessLevels([], sync);

	const gain = (enabled: boolean) => loudnessNormalizationGain({ songLufs: -2, libraryLevels: levels, enabled }).gain;
	expect(gain(true)).toBeCloseTo(10 ** (-6 / 20), 6); // median -14, clamp 6 dB: pulled to -8
	expect(gain(false)).toBe(1);
});

test('a sync without levels keeps the median the TV already holds', () => {
	const held = [-14, -13, -12];
	expect(syncLoudnessLevels(held, { type: 'queue:sync', rev: 2, entries: [] })).toBe(held);
});

test("the TV page adopts the sync's levels in its queue:sync branch", () => {
	// The one line a unit cannot execute: deleting it leaves the TV at unity with every other test green.
	const page = stripComments(read('src/routes/tv/+page.svelte'));
	const branch = page.slice(page.indexOf("e.type === 'queue:sync'"), page.indexOf("e.type === 'singer:presence'"));
	expect(branch).toContain('libraryLoudnessLevels = syncLoudnessLevels(libraryLoudnessLevels, e);');
	expect(page).toMatch(/libraryLoudnessLevels:\s*libraryLoudnessLevels|libraryLevels: libraryLoudnessLevels/);
});
