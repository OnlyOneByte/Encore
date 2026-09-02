// The readiness axis: one deduped result set, three groups. The invariant that matters is that a
// song appears EXACTLY ONCE — the old source-tab UI could show the same song as both "cooked in the
// library" and "raw on YouTube", which is the confusion this partition exists to prevent.
import { test, expect } from 'bun:test';
import { readinessOf, matchesQuery, partitionSearch } from './readiness';
import type { Media } from '@encore/shared';

const m = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: 'Song ' + id,
	durationSec: 200,
	stemStatus: 'none',
	playMode: 'iframe',
	...over
});
const ready = (id: string, over: Partial<Media> = {}) =>
	m(id, { playMode: 'file', stemStatus: 'ready', instrumentalRef: `stems/${id}-instrumental.wav`, ...over });
const cooking = (id: string, over: Partial<Media> = {}) => m(id, { playMode: 'file', stemStatus: 'queued', ...over });

test('readinessOf classifies the three states a singer actually distinguishes', () => {
	expect(readinessOf(ready('a'))).toBe('ready');
	expect(readinessOf(cooking('a'))).toBe('cooking');
	expect(readinessOf(m('a'))).toBe('raw'); // youtube embed — plays with vocals
	// a plain local file is playable but NOT karaoke: it has vocals, so it is raw
	expect(readinessOf(m('a', { source: 'local', playMode: 'file', stemStatus: 'none' }))).toBe('raw');
});

test('matchesQuery covers title and artist, case-insensitively; empty query matches nothing', () => {
	const song = m('a', { title: 'Take On Me', artist: 'a-ha' });
	expect(matchesQuery(song, 'take')).toBe(true);
	expect(matchesQuery(song, 'ON ME')).toBe(true);
	expect(matchesQuery(song, 'a-ha')).toBe(true);
	expect(matchesQuery(song, 'aha')).toBe(false); // substring, not fuzzy — documented behaviour
	expect(matchesQuery(song, 'bohemian')).toBe(false);
	expect(matchesQuery(song, '   ')).toBe(false);
});

test('partitions into ready / cooking / raw', () => {
	const catalog = [ready('r1', { title: 'Take On Me' }), cooking('c1', { title: 'Take On Me live' }), m('x1', { title: 'Bohemian' })];
	const results = [m('n1', { title: 'Take On Me cover' })];
	const p = partitionSearch('take on me', catalog, results);
	expect(p.ready.map((x) => x.id)).toEqual(['r1']);
	expect(p.cooking.map((x) => x.id)).toEqual(['c1']);
	expect(p.raw.map((x) => x.id)).toEqual(['n1']); // 'Bohemian' does not match the query
});

test('THE INVARIANT: a cooked song appears once, as ready — never also as a raw result', () => {
	// The route materializes a resolver hit onto the existing catalog media, so `results` carries the
	// SAME object. Before the sourceRef fix that recognition failed and produced a second raw row.
	const cooked = ready('r1', { title: 'Take On Me', sourceRef: 'djV11Xbc914' });
	const p = partitionSearch('take on me', [cooked], [cooked]);
	expect(p.ready.map((x) => x.id)).toEqual(['r1']);
	expect(p.raw).toHaveLength(0);
	expect(p.ready.length + p.cooking.length + p.raw.length).toBe(1);
});

test('a known cooked song survives the resolver being unreachable (offline / yt-dlp down)', () => {
	const p = partitionSearch('take on me', [ready('r1', { title: 'Take On Me' })], []);
	expect(p.ready.map((x) => x.id)).toEqual(['r1']); // still offered, still instantly singable
});

test('raw keeps the resolver relevance order, with catalog-only songs after it', () => {
	const catalogOnly = m('old', { title: 'Take On Me karaoke version' });
	const results = [m('n1', { title: 'Take On Me A' }), m('n2', { title: 'Take On Me B' })];
	const p = partitionSearch('take on me', [catalogOnly, ...results], results);
	expect(p.raw.map((x) => x.id)).toEqual(['n1', 'n2', 'old']);
});

test('no duplicates when the same media arrives from both catalog and results', () => {
	const song = m('a', { title: 'Take On Me' });
	const p = partitionSearch('take on me', [song, song], [song, song]);
	expect(p.raw).toHaveLength(1);
});
