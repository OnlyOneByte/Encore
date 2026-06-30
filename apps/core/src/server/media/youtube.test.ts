// M4-C2 done-when: second identical query served from cache (no upstream call).
import { test, expect } from 'bun:test';
import { YouTubeResolver } from './youtube';
import type { SearchResult } from './resolver';

const fakeResult = (id: string): SearchResult => ({
	source: 'youtube', sourceRef: id, title: 'T-' + id, durationSec: 200
});

test('second identical query is served from cache (backend called once)', async () => {
	let calls = 0;
	const r = new YouTubeResolver(async (q, n) => {
		calls++;
		return [fakeResult('v1')];
	});
	await r.search('mr brightside', 5);
	await r.search('mr brightside', 5);
	expect(calls).toBe(1); // second hit cache
	expect(r.cacheSize).toBe(1);
});

test('different limit is a different cache key', async () => {
	let calls = 0;
	const r = new YouTubeResolver(async () => { calls++; return [fakeResult('v1')]; });
	await r.search('abba', 5);
	await r.search('abba', 10);
	expect(calls).toBe(2);
});

test('cache expires after ttl', async () => {
	let calls = 0;
	let t = 1000;
	const r = new YouTubeResolver(async () => { calls++; return [fakeResult('v1')]; }, { ttlMs: 100, now: () => t });
	await r.search('queen', 5);
	t += 50; // within ttl
	await r.search('queen', 5);
	expect(calls).toBe(1);
	t += 200; // past ttl
	await r.search('queen', 5);
	expect(calls).toBe(2);
});

test('concurrent identical queries dedupe to one backend call', async () => {
	let calls = 0;
	const r = new YouTubeResolver(async () => {
		calls++;
		await new Promise((res) => setTimeout(res, 20));
		return [fakeResult('v1')];
	});
	await Promise.all([r.search('killers', 5), r.search('killers', 5), r.search('killers', 5)]);
	expect(calls).toBe(1); // all three shared one in-flight promise
});

test('blank query returns nothing without calling backend', async () => {
	let calls = 0;
	const r = new YouTubeResolver(async () => { calls++; return []; });
	expect(await r.search('   ', 5)).toEqual([]);
	expect(calls).toBe(0);
});
