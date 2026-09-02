// The client's readiness view must agree with the server's classification, and must let a live
// media:status win over a stale catalog copy — otherwise tapping "✨ Karaoke" leaves the row looking
// untouched until the next full sync.
import { test, expect } from 'bun:test';
import { readinessOf, displayReadiness, canCook } from './readiness';
import { readinessOf as serverReadinessOf } from '../server/media/readiness';
import type { Media } from '@encore/shared';

const m = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'Take On Me',
	durationSec: 200,
	stemStatus: 'none',
	playMode: 'iframe',
	...over
});

const cases: Media[] = [
	m(),
	m({ playMode: 'file', stemStatus: 'ready' }),
	m({ playMode: 'file', stemStatus: 'queued' }),
	m({ source: 'local', playMode: 'file', stemStatus: 'none' }),
	m({ playMode: 'iframe', stemStatus: 'ready' })
];

test('client and server classify readiness identically for every media shape', () => {
	for (const c of cases) expect(readinessOf(c)).toBe(serverReadinessOf(c));
});

test('a live media:status wins over the catalog copy (the row responds to the tap at once)', () => {
	const raw = m();
	expect(displayReadiness(raw)).toBe('raw');
	expect(displayReadiness(raw, { status: 'queued' })).toBe('cooking');
	expect(displayReadiness(raw, { status: 'separating' })).toBe('cooking');
	expect(displayReadiness(raw, { status: 'ready' })).toBe('ready');
});

test('a failed cook falls back to the catalog, so the song is still queueable with vocals', () => {
	expect(displayReadiness(m(), { status: 'failed' })).toBe('raw');
});

test('only a raw song can be cooked', () => {
	expect(canCook('raw')).toBe(true);
	expect(canCook('ready')).toBe(false);
	expect(canCook('cooking')).toBe(false);
});
