import { test, expect } from 'bun:test';
import { ulid } from './ulid';

test('ulid is 26 chars, Crockford base32', () => {
	const id = ulid();
	expect(id).toHaveLength(26);
	expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('ulids are unique across a batch', () => {
	const set = new Set(Array.from({ length: 5000 }, () => ulid()));
	expect(set.size).toBe(5000);
});

test('ulids are lexicographically sortable by time (later seed sorts later)', () => {
	const early = ulid(1_700_000_000_000);
	const late = ulid(1_700_000_001_000);
	expect(early < late).toBe(true);
});

test('same time seed -> time prefix (first 10 chars) is stable', () => {
	const t = 1_700_000_000_000;
	expect(ulid(t).slice(0, 10)).toBe(ulid(t).slice(0, 10));
});
