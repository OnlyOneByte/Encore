// M4-C5 done-when: shortcuts populated from session history (recent + popular).
import { test, expect } from 'bun:test';
import { createPopularityTracker } from './popularity';

test('recent returns most-recently-added first', () => {
	const p = createPopularityTracker();
	p.recordAdd('a', 1);
	p.recordAdd('b', 2);
	p.recordAdd('c', 3);
	expect(p.recent(2)).toEqual(['c', 'b']);
});

test('recent dedupes a media to its latest add time', () => {
	const p = createPopularityTracker();
	p.recordAdd('a', 1);
	p.recordAdd('b', 2);
	p.recordAdd('a', 5); // a re-added later
	expect(p.recent(2)).toEqual(['a', 'b']);
});

test('popular ranks by add count, tie-broken by recency', () => {
	const p = createPopularityTracker();
	p.recordAdd('a', 1);
	p.recordAdd('a', 2); // a: 2
	p.recordAdd('b', 3); // b: 1
	p.recordAdd('c', 4);
	p.recordAdd('c', 5); // c: 2, more recent than a
	expect(p.popular(3)).toEqual(['c', 'a', 'b']);
});

test('limits are respected', () => {
	const p = createPopularityTracker();
	for (let i = 0; i < 10; i++) p.recordAdd('m' + i, i);
	expect(p.recent(3)).toHaveLength(3);
	expect(p.popular(3)).toHaveLength(3);
});

test('empty tracker returns empty lists', () => {
	const p = createPopularityTracker();
	expect(p.recent(5)).toEqual([]);
	expect(p.popular(5)).toEqual([]);
});
