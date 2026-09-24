// The guide mix through the CORE: the pure path decision, and the two round trips that decide whether a mix
// survives a restart (the DB index and the authoritative sidecar). `guidePath` exists as a pure function so
// that "a song with a mix NEVER also mounts a second element" is testable at all.
import { test, expect, describe } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { read } from '@encore/test-support';
import { tmpdir } from 'node:os';
import { guidePath, hasGuidingTrack, type Media } from '$lib/contract';
import { guideMixKey, GUIDE_MIX_EXT } from '$lib/server/media/paths';
import { derivedRefsOf } from '$lib/server/media/retention';
import { openDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { media } from '$lib/server/db/schema';
import { MediaRepository } from '$lib/server/media/repository';
import { setMediaGuideMix } from '$lib/server/jobs/process';
import {
	writeSidecar,
	readSidecar,
	sidecarFromMedia,
	mediaFromSidecar,
	clearArtifacts,
	SIDECAR_SCHEMA
} from '$lib/server/media/sidecar';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const ready = (over: Partial<Media> = {}): Media =>
	({
		id: 'm1',
		source: 'youtube',
		sourceRef: 'abc',
		title: 'A Song',
		durationSec: 200,
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		...over
	}) as Media;

describe('guidePath — which guide the TV plays, and never both', () => {
	test('a mix wins over the vocals stem, so a second element is never mounted beside it', () => {
		// Mix AND element sounds the vocals twice: a doubled, flanged vocal — what the mix exists to remove.
		const m = ready({ vocalsRef: 'derived/stems/m1-vocals.flac', guideMixRef: guideMixKey('m1') });
		expect(guidePath(m)).toEqual({ kind: 'mix', ref: 'derived/stems/m1-guidemix.flac' });
	});

	test('no mix means NO guide — a vocals stem is not a second audible path', () => {
		// A `vocalsRef` is the stem the mix is BUILT from, not evidence the song can be guided from one
		// playhead. Returning it re-opens the two-decoder path, whose drift governor could only compare
		// `currentTime` — which excludes each element's output latency — and so converged on "aligned"
		// while the room heard an offset. No tuning reaches that, which is why the fallback is gone.
		const m = ready({ vocalsRef: 'derived/stems/m1-vocals.flac' });
		expect(guidePath(m)).toEqual({ kind: 'none' });
	});

	test('a mix on a song that is NOT playable offers nothing — the guide is an overlay on something', () => {
		// Mirrors hasGuidingTrack rather than re-deriving playability, so the two cannot disagree.
		const m = ready({ stemStatus: 'queued', instrumentalRef: undefined, guideMixRef: guideMixKey('m1') });
		expect(guidePath(m)).toEqual({ kind: 'none' });
		expect(hasGuidingTrack(m)).toBe(false);
	});

	test('neither a mix nor a stem is "none", not an element with an empty ref', () => {
		expect(guidePath(ready())).toEqual({ kind: 'none' });
	});

	test('an empty-string mix ref is not a mix — it would resolve to /media/ and 404', () => {
		const m = ready({ vocalsRef: 'derived/stems/m1-vocals.flac', guideMixRef: '' });
		expect(guidePath(m)).toEqual({ kind: 'none' }); // falsy ref → no mix → no guide at all
	});
});

describe('the key', () => {
	test('sits beside the stems it is built from, and cannot read as a mixdown', () => {
		expect(guideMixKey('abc123')).toBe('derived/stems/abc123-guidemix.flac');
	});

	test('is FLAC, matching the worker GUIDE_MIX_EXT — a mismatch 404s on a file that exists', () => {
		expect(GUIDE_MIX_EXT).toBe('flac');
	});
});

describe('the DB column', () => {
	test('0011 applies, defaults null, and round-trips through BOTH mapping directions', () => {
		// Exercise BOTH directions: a dropped `toRow` field records the mix in memory and loses it on restart.
		const { db } = openDb(':memory:');
		runMigrations(db);
		const repo = new MediaRepository(db);
		repo.upsert(ready({ id: 'x1', guideMixRef: guideMixKey('x1') }));
		repo.upsert(ready({ id: 'x0' }));

		const rows = new Map(
			db
				.select()
				.from(media)
				.all()
				.map((r) => [r.id, r.guideMixRef])
		);
		expect(rows.get('x1')).toBe('derived/stems/x1-guidemix.flac');
		expect(rows.get('x0')).toBeNull(); // no mix — guidePath reads this as the two-element path

		// Back through fromRow, null maps to UNDEFINED — not the string "null" and not an empty ref.
		const byId = new Map(repo.all().map((m) => [m.id, m.guideMixRef]));
		expect(byId.get('x1')).toBe('derived/stems/x1-guidemix.flac');
		expect(byId.get('x0')).toBeUndefined();
	});
});

describe('the worker wire field', () => {
	test('the hub reads guideMix off the DECLARED stems record, never structurally', () => {
		// The lesson songProfile paid for: the core read `artifacts.stems.songProfile` while the worker published
		// `artifacts.songProfile`, both mocks agreed with themselves, and every separated song stalled forever.
		const hub = stripComments(read('src/lib/server/jobs/worker-hub.ts'));
		expect(hub).toMatch(/setMediaGuideMix\(\s*job\.mediaId\s*,\s*msg\.artifacts\?\.stems\?\.guideMix/);
		// Rejects a TOP-LEVEL artifacts.guideMix in any spelling, including the cast form
		// `(msg.artifacts as any)?.guideMix` that a `[^)]*` regex cannot see past.
		expect(hub).not.toMatch(/artifacts(?:(?!stems)[\s\S]){0,40}guideMix/);
		expect(hub).toMatch(/discardGuideMix/); // the stale FILE goes too, or the next boot re-adopts it
	});
});

describe('setMediaGuideMix ties the mix to the stem generation that produced it', () => {
	const withMix = () => {
		const map = new Map<string, Media>();
		map.set('m1', ready({ guideMixRef: guideMixKey('m1'), vocalsRef: 'derived/stems/m1-vocals.flac' }));
		return map;
	};

	test('a present ref is recorded', () => {
		const map = withMix();
		expect(setMediaGuideMix('m1', 'derived/stems/m1-guidemix.flac', map)).toBe(true);
		expect(map.get('m1')!.guideMixRef).toBe('derived/stems/m1-guidemix.flac');
	});

	test('an ABSENT ref CLEARS the old one — a stale mix must never survive new stems', () => {
		// A stems-upgrade overwrites both stem files in place, so preserving the ref when the mix encode fails
		// leaves the room playing a mix built from SUPERSEDED stems while instrumentalRef advertises the better
		// ones — unrecoverably, because the backfill then classifies the song `settled`.
		const map = withMix();
		expect(setMediaGuideMix('m1', undefined, map)).toBe(true);
		expect(map.get('m1')!.guideMixRef).toBeUndefined();
	});

	test('clearing leaves NO guide, and that is still safer than preserving a stale one', () => {
		// No guide until re-processing is still the right trade: a confidently-wrong guide is undiagnosable by ear.
		const map = withMix();
		setMediaGuideMix('m1', undefined, map);
		expect(guidePath(map.get('m1')!)).toEqual({ kind: 'none' });
	});

	test('an unknown media is a no-op, not a throw', () => {
		expect(setMediaGuideMix('nope', 'derived/stems/x-guidemix.flac', new Map())).toBe(false);
	});
});

describe('the sidecar round trip — a mix must survive a DB wipe', () => {
	test('written to the sidecar, restored from it, and cleared by eviction', async () => {
		// The sidecar is AUTHORITATIVE and the DB only its index: without this a DB wipe loses every mix.
		const dir = mkdtempSync(join(tmpdir(), 'encore-guidemix-'));
		const prev = process.env.ENCORE_META_DIR;
		process.env.ENCORE_META_DIR = dir;
		try {
			const media = ready({ guideMixRef: guideMixKey('m1'), vocalsRef: 'derived/stems/m1-vocals.flac' });
			await writeSidecar(sidecarFromMedia(media, Date.now()));

			const back = await readSidecar('m1');
			expect(back?.artifacts.guideMix).toBe('derived/stems/m1-guidemix.flac');
			expect(back?.schema).toBe(SIDECAR_SCHEMA);
			expect(mediaFromSidecar(back!).guideMixRef).toBe('derived/stems/m1-guidemix.flac');

			// Eviction deletes the stems the mix is made of, so it must clear the mix ref too.
			await clearArtifacts('m1');
			const cleared = await readSidecar('m1');
			expect(cleared?.artifacts.guideMix ?? null).toBeNull();
			expect(mediaFromSidecar(cleared!).guideMixRef).toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env.ENCORE_META_DIR;
			else process.env.ENCORE_META_DIR = prev;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a schema-5 sidecar with no mix restores as absent — today s behaviour, unchanged', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'encore-guidemix-old-'));
		const prev = process.env.ENCORE_META_DIR;
		process.env.ENCORE_META_DIR = dir;
		try {
			const side = sidecarFromMedia(ready(), Date.now());
			side.schema = 5;
			delete (side.artifacts as { guideMix?: unknown }).guideMix;
			await writeSidecar(side);
			expect(mediaFromSidecar((await readSidecar('m1'))!).guideMixRef).toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env.ENCORE_META_DIR;
			else process.env.ENCORE_META_DIR = prev;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('retention counts and frees it', () => {
	test('the STORED ref is enumerated even when it differs from the id-derived key', () => {
		// A ref that does NOT match the id-derived key is the only case the `m.guideMixRef` arm exists for.
		const m = ready({ guideMixRef: 'derived/stems/legacy-name-guidemix.flac' });
		expect(derivedRefsOf(m)).toContain('derived/stems/legacy-name-guidemix.flac');
	});

	test('the id-derived key is enumerated even when no ref was recorded', () => {
		// A mix whose completion frame never landed is still on disk; the caller's existsSync skips absent ones.
		expect(derivedRefsOf(ready())).toContain('derived/stems/m1-guidemix.flac');
	});
});
