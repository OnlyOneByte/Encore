import { test, expect } from 'bun:test';
import { followUps, separatorFor } from '$lib/server/jobs/dispatch';
import { markMediaReady } from '$lib/server/jobs/make-karaoke';
import {
	isQualityUpgrade,
	qualityRank,
	DEFAULT_GLOBAL_SETTINGS,
	type Media,
	type GlobalSettings
} from '$lib/contract';

const settings = (o: Partial<GlobalSettings> = {}): GlobalSettings => ({
	...DEFAULT_GLOBAL_SETTINGS,
	defaultModel: 'htdemucs',
	...o
});

function media(o: Partial<Media> = {}): Media {
	return {
		id: 'm1',
		source: 'youtube',
		sourceRef: 'abc',
		title: 't',
		durationSec: 100,
		stemStatus: 'none',
		...o
	} as Media;
}

// ── the ladder ────────────────────────────────────────────────────────────────
test('quality ranks order the ladder and unranked pairs score zero', () => {
	expect(qualityRank('demucs', 'htdemucs')).toBeLessThan(qualityRank('demucs', 'htdemucs_ft'));
	expect(qualityRank('demucs', 'htdemucs_ft')).toBeLessThan(qualityRank('roformer', 'bs-roformer-1297'));
	expect(qualityRank('roformer', 'bs-roformer-1297')).toBeLessThan(qualityRank('ensemble', 'instrumental_clean'));
	expect(qualityRank('demucs', 'bogus')).toBe(0);
});

test('isQualityUpgrade requires strictly better and treats missing current as upgradeable', () => {
	const fast = { engine: 'demucs', model: 'htdemucs' };
	const better = { engine: 'demucs', model: 'htdemucs_ft' };
	expect(isQualityUpgrade(fast, better)).toBe(true);
	expect(isQualityUpgrade(better, fast)).toBe(false); // never regress
	expect(isQualityUpgrade(better, better)).toBe(false); // equal is a no-op
	expect(isQualityUpgrade(null, fast)).toBe(true);
	expect(isQualityUpgrade(fast, { engine: 'demucs', model: 'bogus' })).toBe(false);
});

// ── follow-ups ────────────────────────────────────────────────────────────────
test('a cook chains align, and the upgrade only when it would improve quality', () => {
	expect(followUps('stems', settings())).toEqual(['align']); // upgrade disabled
	expect(followUps('stems', settings({ enqueueUpgrade: true }))).toEqual(['align', 'stems-upgrade']);
	// enabled but the "upgrade" is not actually better → not enqueued, so no wasted 40-min cook
	expect(
		followUps('stems', settings({ enqueueUpgrade: true, upgradeEngine: 'demucs', upgradeModel: 'htdemucs' }))
	).toEqual(['align']);
});

test('an upgrade job chains nothing further (depth-1 fan-out)', () => {
	expect(followUps('stems-upgrade', settings({ enqueueUpgrade: true }))).toEqual([]);
	expect(followUps('align', settings())).toEqual([]);
});

// ── provenance + the swap guard ────────────────────────────────────────────────
test('separatorFor reports the pairing a separation job used, and nothing for others', () => {
	expect(separatorFor('stems', settings({ defaultModel: 'htdemucs_ft' }))).toEqual({
		engine: 'demucs',
		model: 'htdemucs_ft'
	});
	expect(separatorFor('stems-upgrade', settings())).toEqual({ engine: 'roformer', model: 'bs-roformer-1297' });
	expect(separatorFor('align', settings())).toBeUndefined();
});

test('a first cook publishes and records its separator', () => {
	const byId = new Map([['m1', media()]]);
	expect(
		markMediaReady('m1', byId, '/abs/derived/stems/m1-instrumental.flac', { engine: 'demucs', model: 'htdemucs' })
	).toBe(true);
	const m = byId.get('m1')!;
	expect(m.stemStatus).toBe('ready');
	expect(m.separator).toEqual({ engine: 'demucs', model: 'htdemucs' });
});

test('a BETTER upgrade replaces the instrumental and its provenance', () => {
	const byId = new Map([
		[
			'm1',
			media({
				stemStatus: 'ready',
				lyricsStatus: 'ready',
				instrumentalRef: 'derived/stems/m1-instrumental.flac',
				separator: { engine: 'demucs', model: 'htdemucs' }
			})
		]
	]);
	expect(
		markMediaReady('m1', byId, '/abs/derived/stems/m1-instrumental.flac', {
			engine: 'roformer',
			model: 'bs-roformer-1297'
		})
	).toBe(true);
	expect(byId.get('m1')!.separator).toEqual({ engine: 'roformer', model: 'bs-roformer-1297' });
});

test('THE INVARIANT: a worse or equal result never replaces a published instrumental', () => {
	const published = { engine: 'roformer', model: 'bs-roformer-1297' };
	const byId = new Map([
		[
			'm1',
			media({
				stemStatus: 'ready',
				lyricsStatus: 'ready',
				instrumentalRef: 'derived/stems/m1-instrumental.flac',
				separator: published
			})
		]
	]);
	// a worse engine result arriving late (e.g. a re-queued plain cook) is refused
	expect(
		markMediaReady('m1', byId, '/abs/derived/stems/m1-instrumental.flac', { engine: 'demucs', model: 'htdemucs' })
	).toBe(false);
	expect(byId.get('m1')!.separator).toEqual(published); // unchanged
	// and an identical re-cook is a no-op rather than a churn
	expect(markMediaReady('m1', byId, '/abs/derived/stems/m1-instrumental.flac', published)).toBe(false);
});

test('a plain cook with no separator reported still publishes (older worker path)', () => {
	const byId = new Map([['m1', media()]]);
	expect(markMediaReady('m1', byId, '/abs/derived/stems/m1-instrumental.flac')).toBe(true);
	expect(byId.get('m1')!.stemStatus).toBe('ready');
});
