// The client's readiness view must agree with the server's classification, and must let a live
// media:status win over a stale catalog copy — otherwise tapping "✨ Karaoke" leaves the row looking
// untouched until the next full sync.
import { test, expect } from 'bun:test';
import { readinessOf, displayReadiness, canCook, readyEmptyState } from './readiness';
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

// Regression (reported from a real party session): "when I hit karaoke on a song, it clears the
// remote of the downloaded library. It just says No karaoke-ready songs yet". The library was never
// cleared — the Ready group is query-scoped while a search is active, so a query matching none of the
// library emptied the group and the phone announced the library was empty. Reproduced with 5 songs
// in /api/library: the group vanished and the false copy appeared; clearing the query brought all 5
// back. These tests pin the copy to the truth.
test('a genuinely empty library keeps the original "none yet" copy', () => {
	const s = readyEmptyState({ searchActive: false, libraryCount: 0 });
	expect(s.message).toContain('No karaoke-ready songs yet');
	expect(s.showAllCount).toBeNull(); // nothing to go back to
});

test('an empty library while searching still says "none yet" (it is true)', () => {
	const s = readyEmptyState({ searchActive: true, libraryCount: 0, query: 'take on me' });
	expect(s.message).toContain('No karaoke-ready songs yet');
	expect(s.showAllCount).toBeNull();
});

test('THE BUG: a non-empty library during a search must NOT claim there are none', () => {
	const s = readyEmptyState({ searchActive: true, libraryCount: 5, query: 'zzzz' });
	expect(s.message).not.toContain('No karaoke-ready songs yet');
	expect(s.message).toContain('5');
	expect(s.message).toContain('zzzz'); // names what was searched
	expect(s.showAllCount).toBe(5); // and offers the one tap back to the library
});

test('singular wording for a one-song library', () => {
	const s = readyEmptyState({ searchActive: true, libraryCount: 1, query: 'x' });
	expect(s.message).toContain('1 karaoke song ');
	expect(s.message).not.toContain('songs');
});

test('a blank query while searchActive still reads sensibly (no empty quotes)', () => {
	const s = readyEmptyState({ searchActive: true, libraryCount: 3, query: '   ' });
	expect(s.message).toContain('match this search');
	expect(s.message).not.toContain('““');
	expect(s.showAllCount).toBe(3);
});

// ── up-next must match what the server will actually play ─────────────────────
// The phone used to label the FIRST queued row "up next". The server's nextPlayable() skips an entry
// whose stems are still cooking, so whenever row 0 was cooking the phone promised a song the TV was
// about to skip past. These pin the agreement.
import { entryPlayable, nextPlayableEntryId } from './readiness';
import { isEntryReady } from '../server/rotation/index';

const entry = (id: string, mediaId: string) => ({ id, mediaId });

test('entryPlayable agrees with the server isEntryReady for every media shape', () => {
	for (const c of cases) {
		const byId = new Map([[c.id, c]]);
		expect(entryPlayable(c)).toBe(isEntryReady({ mediaId: c.id } as never, byId));
	}
});

test('a live cooking status beats a catalog copy that still says ready', () => {
	expect(entryPlayable(m({ playMode: 'file', stemStatus: 'ready' }), { status: 'separating' })).toBe(false);
	expect(entryPlayable(m({ playMode: 'file', stemStatus: 'queued' }), { status: 'ready' })).toBe(true);
});

test('unknown media is not playable (matches the server returning false)', () => {
	expect(entryPlayable(undefined)).toBe(false);
});

test('THE BUG: up-next skips a cooking first entry and names the first READY one', () => {
	const cook = m({ id: 'cooking', playMode: 'file', stemStatus: 'queued' });
	const ready = m({ id: 'ready', playMode: 'file', stemStatus: 'ready' });
	const byId = new Map([[cook.id, cook], [ready.id, ready]]);
	const queued = [entry('e1', 'cooking'), entry('e2', 'ready')];

	const id = nextPlayableEntryId(queued, (k) => byId.get(k), () => undefined);
	expect(id).toBe('e2'); // NOT 'e1' — that one is still separating and yields its turn
});

test('up-next is the first entry when it is already playable', () => {
	const ready = m({ id: 'ready', playMode: 'iframe' });
	const byId = new Map([[ready.id, ready]]);
	const queued = [entry('e1', 'ready'), entry('e2', 'ready')];
	expect(nextPlayableEntryId(queued, (k) => byId.get(k), () => undefined)).toBe('e1');
});

test('nothing playable → no up-next (the whole queue is cooking)', () => {
	const cook = m({ id: 'cooking', playMode: 'file', stemStatus: 'queued' });
	const byId = new Map([[cook.id, cook]]);
	const queued = [entry('e1', 'cooking'), entry('e2', 'cooking')];
	expect(nextPlayableEntryId(queued, (k) => byId.get(k), () => undefined)).toBeNull();
});
