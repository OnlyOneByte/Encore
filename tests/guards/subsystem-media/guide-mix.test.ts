// The guide mix, end to end through the CORE: the pure path decision, and the two round trips that
// decide whether a mix survives a restart (the DB index and the authoritative sidecar).
//
// The decision is what earns its own tests. `guidePath` replaced a branch that would otherwise sit in
// TvPlayer.svelte, where a Svelte effect cannot be executed by `bun test` — so the interesting property
// (a song with a mix NEVER also mounts a second element) would have been untestable at all.
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

/** The repo's source-scan convention: blank comments (preserving offsets) so a commented-out call cannot
 *  satisfy a text assertion — the exact mutation that defeated the first version of this file's scan. */
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
		// The whole point of the union: playing the mix AND the element would sound the vocals twice,
		// once inside the mix and once on top — a doubled, flanged vocal, which is the exact defect
		// class the mix exists to remove.
		const m = ready({ vocalsRef: 'derived/stems/m1-vocals.flac', guideMixRef: guideMixKey('m1') });
		expect(guidePath(m)).toEqual({ kind: 'mix', ref: 'derived/stems/m1-guidemix.flac' });
	});

	test('no mix means NO guide — a vocals stem is not a second audible path', () => {
		// THE INVARIANT OF THE SINGLE-PATH DESIGN. A `vocalsRef` is the stem the mix is BUILT from, so it
		// is not evidence that this song can be guided from one playhead. Returning it here is what
		// re-opens the two-decoder path: a second media element whose drift governor could only compare
		// `currentTime` — which excludes each element's output latency — and so converged on "aligned"
		// while the room heard an offset. Deleted rather than tuned, because no tuning reaches it.
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
		// Falsy ref → no mix → no guide at all. The vocals stem beside it is deliberately NOT a fallback.
		expect(guidePath(m)).toEqual({ kind: 'none' });
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
		// The previous version wrote with `db.insert(...)` and read with `repo.all()`, so `toRow` was never
		// called and dropping the field from it passed. That is precisely the failure the comment claimed to
		// cover: the mix is recorded in memory, vanishes on restart, and the room quietly reverts.
		const { db } = openDb(':memory:');
		runMigrations(db);
		const repo = new MediaRepository(db);
		repo.upsert(ready({ id: 'x1', guideMixRef: guideMixKey('x1') }));
		repo.upsert(ready({ id: 'x0' }));

		// Through toRow: the column actually holds it.
		const rows = new Map(
			db
				.select()
				.from(media)
				.all()
				.map((r) => [r.id, r.guideMixRef])
		);
		expect(rows.get('x1')).toBe('derived/stems/x1-guidemix.flac');
		expect(rows.get('x0')).toBeNull(); // no mix — guidePath reads this as the two-element path

		// And back through fromRow: null maps to UNDEFINED, not to the string "null" or an empty ref.
		const byId = new Map(repo.all().map((m) => [m.id, m.guideMixRef]));
		expect(byId.get('x1')).toBe('derived/stems/x1-guidemix.flac');
		expect(byId.get('x0')).toBeUndefined();
	});
});

describe('the worker wire field', () => {
	test('the hub reads guideMix off the DECLARED stems record, never structurally', () => {
		// The lesson songProfile paid for: the core read `artifacts.stems.songProfile` while the worker
		// published `artifacts.songProfile`, both sides' unit tests passed against their own mocks, and
		// every separated song stalled forever. A source scan is the only thing that catches it — but only
		// with comments STRIPPED, because a raw-text match is satisfied by the commented-out call.
		const hub = stripComments(read('src/lib/server/jobs/worker-hub.ts'));
		expect(hub).toMatch(/setMediaGuideMix\(\s*job\.mediaId\s*,\s*msg\.artifacts\?\.stems\?\.guideMix/);
		// Reject reaching for a TOP-LEVEL artifacts.guideMix in any spelling — `artifacts` followed by
		// `guideMix` with no `stems` in between. That also catches the cast form
		// `(msg.artifacts as any)?.guideMix`, which is how the original songProfile bug was written and
		// which a `[^)]*` regex cannot see past.
		expect(hub).not.toMatch(/artifacts(?:(?!stems)[\s\S]){0,40}guideMix/);
		// And the stale FILE must be discarded when the ref clears, or the next boot re-adopts it.
		expect(hub).toMatch(/discardGuideMix/);
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
		// The defect this pins. A stems-upgrade re-separates with a better model and overwrites both stem
		// files in place. Preserving the ref when its encode fails leaves the room playing a mix built from
		// the SUPERSEDED stems, while instrumentalRef and Media.separator both advertise the better ones —
		// and unrecoverably, because the backfill then classifies the song `settled`.
		const map = withMix();
		expect(setMediaGuideMix('m1', undefined, map)).toBe(true);
		expect(map.get('m1')!.guideMixRef).toBeUndefined();
	});

	test('clearing leaves NO guide, and that is still safer than preserving a stale one', () => {
		// The safety argument, restated for the single-path design. Clearing used to be justified by "the
		// song still has a guide, just the drift-governed one" — there is no such fallback any more, so
		// clearing now means the song offers no guide until it is re-processed. That is STILL the right
		// trade: the mix on disk was built from stems this frame just superseded, so preserving the ref
		// would play the room a guide that no longer matches the instrumental beside it. Silence about a
		// guide is recoverable by re-processing; a confidently-wrong guide is not diagnosable by ear.
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
		// The sidecar is the AUTHORITATIVE record and the DB only its index, so this is the difference
		// between "a DB wipe restores every mix" and "a DB wipe silently loses every mix and every room
		// quietly reverts to the drifting two-element path". Nothing tested any of it.
		const dir = mkdtempSync(join(tmpdir(), 'encore-guidemix-'));
		const prev = process.env.ENCORE_META_DIR;
		process.env.ENCORE_META_DIR = dir;
		try {
			const media = ready({ guideMixRef: guideMixKey('m1'), vocalsRef: 'derived/stems/m1-vocals.flac' });
			await writeSidecar(sidecarFromMedia(media, Date.now()));

			const back = await readSidecar('m1');
			expect(back?.artifacts.guideMix).toBe('derived/stems/m1-guidemix.flac');
			expect(back?.schema).toBe(SIDECAR_SCHEMA);
			// …and restoring a Media from it recovers the ref, which is what makes the mix survive.
			expect(mediaFromSidecar(back!).guideMixRef).toBe('derived/stems/m1-guidemix.flac');

			// Eviction deleted the stems the mix is made of, so it must clear the mix too — otherwise the
			// sidecar keeps pointing the TV at a file that is gone.
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
		// Vacuous before: the fixture's stored ref WAS `guideMixKey(m.id)`, so the two candidates were the
		// same string and removing `m.guideMixRef` from the enumeration changed nothing. A ref that does not
		// match the derived key is the only case that line exists for.
		const m = ready({ guideMixRef: 'derived/stems/legacy-name-guidemix.flac' });
		expect(derivedRefsOf(m)).toContain('derived/stems/legacy-name-guidemix.flac');
	});

	test('the id-derived key is enumerated even when no ref was recorded', () => {
		// A mix written by a process whose completion frame never landed still exists on disk; naming the
		// key is free because an absent file is skipped by the caller's existsSync.
		expect(derivedRefsOf(ready())).toContain('derived/stems/m1-guidemix.flac');
	});
});
