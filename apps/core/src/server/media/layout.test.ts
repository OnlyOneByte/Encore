// The storage layout: class-aware key resolution, the absolute-path normalizer, and the
// one-shot migration off the legacy layout. Uses a real temp filesystem, because the whole point of
// the migration is that it moves actual bytes.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	audioKey,
	instrumentalKey,
	vocalsKey,
	pitchKey,
	lyricsKey,
	metaKey,
	classOf,
	toRelativeKey,
	mediaRoot
} from './paths';
import { planMigration, applyMigration, needsMigration, ensureLayout } from './migrate-layout';
import { safeMediaPath } from './local-files';

let root: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['MEDIA_DIR', 'ENCORE_AUDIO_DIR', 'ENCORE_DERIVED_DIR', 'ENCORE_META_DIR'];

beforeEach(() => {
	for (const k of ENV) saved[k] = process.env[k];
	root = mkdtempSync(join(tmpdir(), 'encore-layout-'));
	process.env.MEDIA_DIR = root;
	for (const k of ENV.slice(1)) delete process.env[k];
});
afterEach(() => {
	for (const k of ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(root, { recursive: true, force: true });
});

describe('keys', () => {
	it('every artifact class has a stable relative key', () => {
		expect(audioKey('m1')).toBe('audio/m1.wav');
		expect(audioKey('m1', 'm4a')).toBe('audio/m1.m4a');
		// the two stems get different formats: lossless where it is heard, lossy where it is not
		expect(instrumentalKey('m1')).toBe('derived/stems/m1-instrumental.flac');
		expect(vocalsKey('m1')).toBe('derived/stems/m1-vocals.m4a');
		// a pre-policy song keeps its own extension — the ref is stored per media, not re-derived
		expect(instrumentalKey('m1', 'wav')).toBe('derived/stems/m1-instrumental.wav');
		expect(pitchKey('m1')).toBe('derived/pitch/m1-pitch.json');
		expect(lyricsKey('m1')).toBe('derived/lyrics/m1.json');
		expect(metaKey('m1')).toBe('meta/m1.json');
	});

	it('classifies a ref by its first segment', () => {
		expect(classOf('audio/m1.wav')).toBe('audio');
		expect(classOf('derived/stems/m1-instrumental.m4a')).toBe('derived');
		expect(classOf('meta/m1.json')).toBe('meta');
		expect(classOf('library/song.mp4')).toBe('root'); // legacy/library files
	});
});

describe('toRelativeKey — the absolute-path bug', () => {
	it('normalizes a worker-reported absolute path back to a servable ref', () => {
		// Workers hand back os.path.join(media_dir, key). safeMediaPath rejects anything starting
		// with "/", so storing the raw uri meant lyricsRef/pitchRef could never be fetched.
		const abs = join(root, 'derived', 'lyrics', 'm1.json');
		expect(toRelativeKey(abs)).toBe('derived/lyrics/m1.json');
	});

	it('passes a relative ref through untouched', () => {
		expect(toRelativeKey('derived/pitch/m1-pitch.json')).toBe('derived/pitch/m1-pitch.json');
	});

	it('returns null for a path outside every storage class', () => {
		// a worker writing somewhere we do not serve is a config error, not something to persist
		expect(toRelativeKey('/etc/passwd')).toBeNull();
		expect(toRelativeKey('')).toBeNull();
		expect(toRelativeKey(undefined)).toBeNull();
	});

	it('resolves against a class dir pointed OUTSIDE the media root', () => {
		const far = mkdtempSync(join(tmpdir(), 'encore-audio-'));
		process.env.ENCORE_AUDIO_DIR = far;
		expect(toRelativeKey(join(far, 'm1.wav'))).toBe('audio/m1.wav');
		rmSync(far, { recursive: true, force: true });
	});
});

describe('safeMediaPath is class-aware and still traversal-proof', () => {
	it('resolves a derived ref under the derived root', () => {
		expect(safeMediaPath('derived/stems/m1-instrumental.m4a')).toBe(join(root, 'derived', 'stems', 'm1-instrumental.m4a'));
		// a legacy .wav ref from before the audio policy must still resolve
		expect(safeMediaPath('derived/stems/m1-instrumental.wav')).toBe(join(root, 'derived', 'stems', 'm1-instrumental.wav'));
	});

	it('resolves a class dir on another volume', () => {
		const far = mkdtempSync(join(tmpdir(), 'encore-audio-'));
		process.env.ENCORE_AUDIO_DIR = far;
		expect(safeMediaPath('audio/m1.wav')).toBe(join(far, 'm1.wav'));
		rmSync(far, { recursive: true, force: true });
	});

	it('still refuses traversal, absolute paths and NUL', () => {
		expect(safeMediaPath('../../etc/passwd')).toBeNull();
		expect(safeMediaPath('derived/../../etc/passwd')).toBeNull();
		expect(safeMediaPath('/etc/passwd')).toBeNull();
		expect(safeMediaPath('a\0b')).toBeNull();
		expect(safeMediaPath('%2e%2e%2fetc%2fpasswd')).toBeNull();
		expect(safeMediaPath('')).toBeNull();
	});

	it('never serves the sidecar records or the thumb cache', () => {
		// meta/ is the library's source of truth and carries retained raw metadata — not streamable.
		expect(safeMediaPath('meta/m1.json')).toBeNull();
		expect(safeMediaPath('derived/thumbs/abc.jpg')).toBeNull();
		expect(safeMediaPath('.thumbs/abc.jpg')).toBeNull();
	});
});

describe('migration off the legacy layout', () => {
	function seedLegacy() {
		mkdirSync(join(root, 'stems', '_work', 'm1'), { recursive: true });
		writeFileSync(join(root, 'stems', '_work', 'm1', 'source.wav'), 'RAW-AUDIO-M1');
		mkdirSync(join(root, 'stems', '_work', 'm2'), { recursive: true });
		writeFileSync(join(root, 'stems', '_work', 'm2', 'source.wav'), 'RAW-AUDIO-M2');
		writeFileSync(join(root, 'stems', 'm1-instrumental.wav'), 'INST-M1');
		writeFileSync(join(root, 'stems', 'm1-vocals.wav'), 'VOX-M1');
		mkdirSync(join(root, 'pitch'), { recursive: true });
		writeFileSync(join(root, 'pitch', 'm1-pitch.json'), '{}');
		mkdirSync(join(root, 'lyrics'), { recursive: true });
		writeFileSync(join(root, 'lyrics', 'm1.json'), '{}');
	}

	it('PROMOTES the raw audio out of scratch instead of deleting it with the rest', () => {
		seedLegacy();
		applyMigration(planMigration(root));
		// the one unrecoverable asset survives, as a first-class file
		expect(readFileSync(join(root, 'audio', 'm1.wav'), 'utf8')).toBe('RAW-AUDIO-M1');
		expect(readFileSync(join(root, 'audio', 'm2.wav'), 'utf8')).toBe('RAW-AUDIO-M2');
		// and the scratch dir itself is gone
		expect(existsSync(join(root, 'stems', '_work'))).toBe(false);
	});

	it('moves derived artifacts under derived/', () => {
		seedLegacy();
		applyMigration(planMigration(root));
		expect(readFileSync(join(root, 'derived', 'stems', 'm1-instrumental.wav'), 'utf8')).toBe('INST-M1');
		expect(readFileSync(join(root, 'derived', 'stems', 'm1-vocals.wav'), 'utf8')).toBe('VOX-M1');
		expect(existsSync(join(root, 'derived', 'pitch', 'm1-pitch.json'))).toBe(true);
		expect(existsSync(join(root, 'derived', 'lyrics', 'm1.json'))).toBe(true);
	});

	it('reports the DB ref rewrites so refs keep pointing at real files', () => {
		seedLegacy();
		const rewrites = new Map<string, Record<string, string>>();
		applyMigration(planMigration(root), (id, fields) => {
			rewrites.set(id, { ...(rewrites.get(id) ?? {}), ...fields });
		});
		expect(rewrites.get('m1')).toMatchObject({
			audioRef: 'audio/m1.wav',
			// a migrated legacy stem keeps its .wav name — the migration moves bytes, it does not transcode
			instrumentalRef: 'derived/stems/m1-instrumental.wav',
			pitchRef: 'derived/pitch/m1-pitch.json',
			lyricsRef: 'derived/lyrics/m1.json'
		});
	});

	it('is IDEMPOTENT — a second run is a no-op and moves nothing', () => {
		seedLegacy();
		const first = applyMigration(planMigration(root));
		expect(first.moved).toBeGreaterThan(0);
		expect(needsMigration(root)).toBe(false);

		const second = applyMigration(planMigration(root));
		expect(second.moved).toBe(0);
		// the migrated files are untouched
		expect(readFileSync(join(root, 'audio', 'm1.wav'), 'utf8')).toBe('RAW-AUDIO-M1');
	});

	it('is a no-op on a fresh volume', () => {
		expect(needsMigration(root)).toBe(false);
		expect(applyMigration(planMigration(root)).moved).toBe(0);
	});

	it('never clobbers an existing destination', () => {
		seedLegacy();
		mkdirSync(join(root, 'audio'), { recursive: true });
		writeFileSync(join(root, 'audio', 'm1.wav'), 'ALREADY-HERE');
		applyMigration(planMigration(root));
		expect(readFileSync(join(root, 'audio', 'm1.wav'), 'utf8')).toBe('ALREADY-HERE');
	});

	it('refuses to prune a legacy dir that still holds files it did not understand', () => {
		mkdirSync(join(root, 'pitch'), { recursive: true });
		writeFileSync(join(root, 'pitch', 'm1-pitch.json'), '{}');
		const plan = planMigration(root);
		// drop the move so the file stays put, then confirm the dir is NOT deleted with data in it
		const res = applyMigration({ ...plan, moves: [] });
		expect(existsSync(join(root, 'pitch', 'm1-pitch.json'))).toBe(true);
		expect(res.pruned).toBe(0);
	});

	it('ONE unmovable file does not abandon the rest of the migration', () => {
		// The real failure mode: a scratch dir written by the worker CONTAINER is owned by its uid, so
		// renaming a file out of it is EACCES. The first live run of this crashed server startup.
		seedLegacy();
		const plan = planMigration(root);
		const bogus = join(root, 'stems', '_work', 'ghost', 'source.wav');
		const withBadEntry = { ...plan, moves: [[bogus, join(root, 'audio', 'ghost.wav')] as [string, string], ...plan.moves] };
		const res = applyMigration(withBadEntry);
		// the missing one is skipped, everything real still moved
		expect(res.skipped).toBeGreaterThan(0);
		expect(readFileSync(join(root, 'audio', 'm1.wav'), 'utf8')).toBe('RAW-AUDIO-M1');
		expect(readFileSync(join(root, 'derived', 'stems', 'm1-instrumental.wav'), 'utf8')).toBe('INST-M1');
	});

	it('preserves the bytes by COPYING when the source cannot be removed', () => {
		// A read-only source directory: rename and unlink both fail, copy still works. Losing the only
		// unrecoverable class to a permission bit would be the worse outcome, so a copy counts as done.
		seedLegacy();
		const dir = join(root, 'stems', '_work', 'm1');
		chmodSync(dir, 0o500); // r-x: can read/traverse, cannot unlink
		try {
			const res = applyMigration(planMigration(root));
			expect(readFileSync(join(root, 'audio', 'm1.wav'), 'utf8')).toBe('RAW-AUDIO-M1'); // asset safe
			expect(res.copiedInPlace).toBeGreaterThan(0);
			expect(res.failed).toBe(0);
		} finally {
			chmodSync(dir, 0o700);
		}
	});

	it('ensureLayout creates every class dir', () => {
		ensureLayout();
		for (const d of ['audio', 'derived/stems', 'derived/pitch', 'derived/lyrics', 'derived/thumbs', 'meta', 'work']) {
			expect(existsSync(join(root, ...d.split('/')))).toBe(true);
		}
		expect(mediaRoot()).toBe(root);
	});

	it('worker-written dirs are SHARED-WRITE, meta is not', () => {
		// The core and the worker are different uids on one mounted volume. A 0755 dir created by the
		// core is unwritable by the worker -- which is how the layout migration first broke every cook with
		// "Permission denied: /app/media/work/<jobId>". meta/ is core-only and stays restrictive.
		ensureLayout();
		const mode = (p: string) => statSync(p).mode & 0o777;
		for (const d of ['audio', 'derived/stems', 'derived/pitch', 'derived/lyrics', 'work']) {
			expect(mode(join(root, ...d.split('/')))).toBe(0o777);
		}
		expect(mode(join(root, 'meta'))).not.toBe(0o777);
	});
});
