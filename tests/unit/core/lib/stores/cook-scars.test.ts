// Scars are the first persisted client state in the app. The load-bearing behaviours are
// the TTL boundary, the storage-failure degradation, and that the snapshot carries enough to render a
// failed row after a reload. The pure helpers are tested with hard-coded deadlines (never derived
// through the same expression the code uses); the I/O layer runs through an injectable in-memory
// Storage so no DOM is needed.
import { test, expect } from 'bun:test';
import type { Media } from '$lib/contract';
import {
	COOK_SCARS_KEY,
	COOK_SCAR_TTL_MS,
	pruneScars,
	snapshotOf,
	scarToMedia,
	readScars,
	recordScar,
	clearScar,
	activeScars,
	type ScarMap
} from '$lib/stores/cook-scars';

const media = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'Take On Me',
	artist: 'a-ha',
	durationSec: 200,
	stemStatus: 'none',
	...over
});

const scar = (expiresAt: number, m: Media = media()) => ({ expiresAt, media: snapshotOf(m) });

// A minimal in-memory Storage so the I/O layer runs without localStorage (bun's runtime has none).
function fakeStorage(seed: Record<string, string> = {}): Storage {
	const m = new Map(Object.entries(seed));
	return {
		get length() {
			return m.size;
		},
		clear: () => m.clear(),
		getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
		setItem: (k: string, v: string) => void m.set(k, String(v)),
		removeItem: (k: string) => void m.delete(k),
		key: (i: number) => [...m.keys()][i] ?? null
	} as Storage;
}

// A Storage that throws on every access — models private-mode / disabled storage.
function throwingStorage(): Storage {
	const boom = () => {
		throw new Error('storage disabled');
	};
	return {
		get length(): number {
			return boom();
		},
		clear: boom,
		getItem: boom,
		setItem: boom,
		removeItem: boom,
		key: boom
	} as unknown as Storage;
}

test('TTL constant is 30 minutes in ms', () => {
	expect(COOK_SCAR_TTL_MS).toBe(1_800_000); // hard fact, not derived
});

test('snapshotOf keeps only the render fields and drops cook-state fields', () => {
	const snap = snapshotOf(media({ stemStatus: 'ready', instrumentalRef: 'inst', thumbnail: 't' }));
	expect(snap).toEqual({
		id: 'm1',
		source: 'youtube',
		sourceRef: 'vid',
		title: 'Take On Me',
		durationSec: 200,
		artist: 'a-ha',
		artistCanonical: undefined,
		thumbnail: 't',
		viewCount: undefined
	});
	// no stemStatus / instrumentalRef leaked
	expect('stemStatus' in snap).toBe(false);
	expect('instrumentalRef' in snap).toBe(false);
});

test('scarToMedia rehydrates a valid un-cooked Media', () => {
	expect(scarToMedia(scar(1))).toMatchObject({ id: 'm1', title: 'Take On Me', stemStatus: 'none' });
});

test('pruneScars keeps only scars whose deadline is strictly after now', () => {
	const input: ScarMap = { future: scar(200), exact: scar(100), past: scar(50) };
	expect(pruneScars(input, 100)).toEqual({ future: scar(200) }); // deadline exclusive at now=100
	// corrupt entries (missing media / non-number expiry) are dropped
	const corrupt = {
		bad: { expiresAt: 'x' } as unknown as ScarMap[string],
		nomedia: { expiresAt: 999 } as ScarMap[string],
		ok: scar(999)
	};
	expect(pruneScars(corrupt as ScarMap, 100)).toEqual({ ok: scar(999) });
	expect(input).toEqual({ future: scar(200), exact: scar(100), past: scar(50) }); // input not mutated
});

test('recordScar writes a snapshot + deadline TTL ahead of now under the shared key', () => {
	const store = fakeStorage();
	recordScar(media(), 1_000, store);
	const raw = JSON.parse(store.getItem(COOK_SCARS_KEY)!); // read RAW, not via readScars
	expect(raw.m1.expiresAt).toBe(1_000 + COOK_SCAR_TTL_MS);
	expect(raw.m1.media.title).toBe('Take On Me');
});

test('recordScar prunes stale scars in the same write (no unbounded growth)', () => {
	const store = fakeStorage({ [COOK_SCARS_KEY]: JSON.stringify({ old: scar(500) }) });
	recordScar(media({ id: 'fresh' }), 600, store); // now past old's 500 deadline
	expect(Object.keys(readScars(store)).sort()).toEqual(['fresh']);
});

test('clearScar removes exactly one scar and is a no-op when absent', () => {
	const store = fakeStorage();
	recordScar(media({ id: 'a' }), 1_000, store);
	recordScar(media({ id: 'b' }), 1_000, store);
	clearScar('a', 1_000, store);
	expect(Object.keys(readScars(store)).sort()).toEqual(['b']);
	clearScar('never', 1_000, store); // no throw, rest intact
	expect(Object.keys(readScars(store)).sort()).toEqual(['b']);
});

test('activeScars returns unexpired media and self-cleans expired entries from storage', () => {
	const store = fakeStorage({
		[COOK_SCARS_KEY]: JSON.stringify({
			live: scar(2_000, media({ id: 'live' })),
			dead: scar(500, media({ id: 'dead' }))
		})
	});
	const out = activeScars(1_000, store); // now=1000: live survives, dead expired
	expect(out.map((m) => m.id)).toEqual(['live']);
	expect(out[0].stemStatus).toBe('none');
	expect(Object.keys(readScars(store))).toEqual(['live']); // dead pruned back to storage
});

test('malformed stored value degrades to no scars', () => {
	expect(readScars(fakeStorage({ [COOK_SCARS_KEY]: 'not json' }))).toEqual({});
	expect(readScars(fakeStorage({ [COOK_SCARS_KEY]: '[1,2,3]' }))).toEqual({});
	expect(readScars(fakeStorage({ [COOK_SCARS_KEY]: 'null' }))).toEqual({});
});

test('a throwing Storage never propagates — reads empty, writes are swallowed', () => {
	const s = throwingStorage();
	expect(readScars(s)).toEqual({});
	expect(() => recordScar(media(), 1_000, s)).not.toThrow();
	expect(() => clearScar('x', 1_000, s)).not.toThrow();
	expect(activeScars(1_000, s)).toEqual([]);
});
