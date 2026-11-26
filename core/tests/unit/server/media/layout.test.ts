// The storage layout: class-aware key resolution, the absolute-path normalizer, and the one-shot migration
// off the legacy layout — on a real temp filesystem, because the migration moves actual bytes.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	audioKey,
	instrumentalKey,
	vocalsKey,
	lyricsKey,
	metaKey,
	classOf,
	toRelativeKey,
	mediaRoot
} from '$lib/server/media/paths';
import { planMigration, applyMigration, ensureLayout } from '$lib/server/media/migrate-layout';

// The predicate `migrateStorageLayout` itself uses, so the test cannot pass against a different one.
const nothingLeftToDo = (root: string) => {
	const plan = planMigration(root);
	return plan.moves.length === 0 && plan.prunes.length === 0;
};
import { safeMediaPath } from '$lib/server/media/local-files';

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
		// Both stems are lossless FLAC: one codec, one container, a sample-exact common start.
		expect(instrumentalKey('m1')).toBe('derived/stems/m1-instrumental.flac');
		expect(vocalsKey('m1')).toBe('derived/stems/m1-vocals.flac');
		// A pre-policy song keeps its own extension — the ref is stored per media, not re-derived.
		expect(instrumentalKey('m1', 'wav')).toBe('derived/stems/m1-instrumental.wav');
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
		// Workers hand back os.path.join(media_dir, key), and safeMediaPath rejects anything starting with
		// "/", so storing the raw uri means lyricsRef can never be fetched.
		const abs = join(root, 'derived', 'lyrics', 'm1.json');
		expect(toRelativeKey(abs)).toBe('derived/lyrics/m1.json');
	});

	it('passes a relative ref through untouched', () => {
		// The body was empty, so this named an invariant it never checked. A ref that is ALREADY relative must
		// survive verbatim — it is what the store is keyed on, so rewriting it would 404 a file that exists. A
		// leading-slash ref is not this case: it is absolute, so it takes the class-root branch above.
		expect(toRelativeKey('derived/lyrics/m1.json')).toBe('derived/lyrics/m1.json');
		expect(toRelativeKey('audio/m1.wav')).toBe('audio/m1.wav');
	});

	it('returns null for a path outside every storage class', () => {
		expect(toRelativeKey('/etc/passwd')).toBeNull(); // a path we do not serve is a config error
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
		expect(safeMediaPath('derived/stems/m1-instrumental.m4a')).toBe(
			join(root, 'derived', 'stems', 'm1-instrumental.m4a')
		);
		// A legacy .wav ref from before the audio policy must still resolve.
		expect(safeMediaPath('derived/stems/m1-instrumental.wav')).toBe(
			join(root, 'derived', 'stems', 'm1-instrumental.wav')
		);
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
		// meta/ is the library's source of truth and carries retained raw metadata; it is not streamable.
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
		mkdirSync(join(root, 'lyrics'), { recursive: true });
		writeFileSync(join(root, 'lyrics', 'm1.json'), '{}');
	}

	it('PROMOTES the raw audio out of scratch instead of deleting it with the rest', () => {
		seedLegacy();
		applyMigration(planMigration(root));
		// The one unrecoverable class survives as a first-class file; the scratch dir itself goes.
		expect(readFileSync(join(root, 'audio', 'm1.wav'), 'utf8')).toBe('RAW-AUDIO-M1');
		expect(readFileSync(join(root, 'audio', 'm2.wav'), 'utf8')).toBe('RAW-AUDIO-M2');
		expect(existsSync(join(root, 'stems', '_work'))).toBe(false);
	});

	it('moves derived artifacts under derived/', () => {
		seedLegacy();
		applyMigration(planMigration(root));
		expect(readFileSync(join(root, 'derived', 'stems', 'm1-instrumental.wav'), 'utf8')).toBe('INST-M1');
		expect(readFileSync(join(root, 'derived', 'stems', 'm1-vocals.wav'), 'utf8')).toBe('VOX-M1');
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
			// a migrated legacy stem keeps its .wav name: the migration moves bytes, it does not transcode
			instrumentalRef: 'derived/stems/m1-instrumental.wav',
			lyricsRef: 'derived/lyrics/m1.json'
		});
	});

	it('is IDEMPOTENT — a second run is a no-op and moves nothing', () => {
		seedLegacy();
		const first = applyMigration(planMigration(root));
		expect(first.moved).toBeGreaterThan(0);
		expect(nothingLeftToDo(root)).toBe(true);

		const second = applyMigration(planMigration(root));
		expect(second.moved).toBe(0);
		expect(readFileSync(join(root, 'audio', 'm1.wav'), 'utf8')).toBe('RAW-AUDIO-M1'); // untouched
	});

	it('is a no-op on a fresh volume', () => {
		expect(nothingLeftToDo(root)).toBe(true);
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
		const plan = planMigration(root);
		const res = applyMigration({ ...plan, moves: [] }); // no move, so the file stays put
		expect(res.pruned).toBe(0);
	});

	it('ONE unmovable file does not abandon the rest of the migration', () => {
		// A scratch dir written by the worker CONTAINER is owned by its uid, so renaming a file out of it is
		// EACCES — which crashed server startup on the first live run.
		seedLegacy();
		const plan = planMigration(root);
		const bogus = join(root, 'stems', '_work', 'ghost', 'source.wav');
		const withBadEntry = {
			...plan,
			moves: [[bogus, join(root, 'audio', 'ghost.wav')] as [string, string], ...plan.moves]
		};
		const res = applyMigration(withBadEntry);
		expect(res.skipped).toBeGreaterThan(0); // the missing one is skipped, everything real still moved
		expect(readFileSync(join(root, 'audio', 'm1.wav'), 'utf8')).toBe('RAW-AUDIO-M1');
		expect(readFileSync(join(root, 'derived', 'stems', 'm1-instrumental.wav'), 'utf8')).toBe('INST-M1');
	});

	// Skipped as root (#1094): no permission bit denies root an unlink, so a root process never meets this case
	// and the test cannot build it. CI runs the suite as an unprivileged user, so it still runs there.
	it.skipIf(process.getuid?.() === 0)('preserves the bytes by COPYING when the source cannot be removed', () => {
		// A read-only source dir: rename and unlink both fail but copy works, and losing the only
		// unrecoverable class to a permission bit is worse, so a copy counts as done.
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
		for (const d of ['audio', 'derived/stems', 'derived/lyrics', 'derived/thumbs', 'meta', 'work']) {
			expect(existsSync(join(root, ...d.split('/')))).toBe(true);
		}
		expect(mediaRoot()).toBe(root);
	});

	it('worker-written dirs are GROUP-writable, never world-writable, and meta is neither', () => {
		// Core and worker are different uids on one mounted volume, so a 0755 dir created by the core is
		// unwritable by the worker and every process dies with "Permission denied: /app/media/work/<jobId>".
		// Compose puts the worker in core's group; a world-writable dir let any local user plant a file (#1206).
		ensureLayout();
		const mode = (p: string) => statSync(p).mode & 0o7777;
		for (const d of ['audio', 'derived/stems', 'derived/lyrics', 'work']) {
			expect(mode(join(root, ...d.split('/')))).toBe(0o775);
		}
		// Sticky on the two parents, so the group cannot rename core's meta/ (or another core dir) out of the way.
		expect(mode(root)).toBe(0o1775);
		expect(mode(join(root, 'derived'))).toBe(0o1775);
		expect(mode(join(root, 'meta')) & 0o022).toBe(0);
	});

	it('a parent already at 1775 is left alone, so an older Bun cannot strip a hand-set sticky bit', () => {
		ensureLayout();
		const parents = [root, join(root, 'derived')];
		// chmod(1), not chmodSync: Bun 1.3's chmodSync drops the bit, which is the case this guards (#1222).
		for (const d of parents) expect(Bun.spawnSync(['chmod', '1775', '--', d]).exitCode).toBe(0);
		const before = parents.map((d) => statSync(d).ctimeMs);
		ensureLayout();
		// Any chmod bumps ctime, even to the same mode, so an unchanged ctime means the dir was not rewritten.
		expect(parents.map((d) => statSync(d).ctimeMs)).toEqual(before);
		for (const d of parents) expect(statSync(d).mode & 0o7777).toBe(0o1775);
	});

	it('an upgrade re-modes a 0777 dir core owns, with no hand step', () => {
		mkdirSync(join(root, 'work'), { recursive: true });
		chmodSync(join(root, 'work'), 0o777);
		ensureLayout();
		expect(statSync(join(root, 'work')).mode & 0o7777).toBe(0o775);
	});

	// A child Bun, so HOME (read by os.homedir) can be a dir this test owns.
	const layoutIn = (env: Record<string, string>) => {
		const layout = join(import.meta.dir, '../../../../src/lib/server/media/migrate-layout.ts');
		return Bun.spawnSync(
			[process.execPath, '-e', `const m = await import(${JSON.stringify(layout)}); m.ensureLayout();`],
			{ cwd: root, env: { MEDIA_DIR: root, PATH: process.env.PATH ?? '', ...env }, stderr: 'pipe' }
		);
	};

	it('a MEDIA_DIR that is the home dir keeps its own mode, and the warning says why', () => {
		chmodSync(root, 0o700);
		const child = layoutIn({ HOME: root });
		expect(child.exitCode).toBe(0);
		expect(statSync(root).mode & 0o7777).toBe(0o700);
		expect(child.stderr.toString()).toContain('shared directory');
	});

	// R3-M1: each configurable class dir, at the home dir or above it, is left alone too.
	for (const [envVar, at] of [
		['ENCORE_AUDIO_DIR', 'home'],
		['ENCORE_DERIVED_DIR', 'home'],
		['ENCORE_META_DIR', 'home'],
		['ENCORE_META_DIR', 'above home']
	] as const) {
		it(`an ${envVar} at the ${at} dir keeps its own mode`, () => {
			const home = join(root, 'up', 'home');
			mkdirSync(home, { recursive: true });
			const dir = at === 'home' ? home : join(root, 'up');
			chmodSync(dir, 0o700);
			const child = layoutIn({ HOME: home, [envVar]: dir });
			expect(child.exitCode).toBe(0);
			expect(statSync(dir).mode & 0o7777).toBe(0o700);
			expect(child.stderr.toString()).toContain(`${dir} is a shared directory`);
		});
	}

	it('with no chmod(1) on PATH, the parents get 1775 from the API alone, with no warning', () => {
		for (const d of ['', 'derived']) {
			mkdirSync(join(root, d), { recursive: true });
			chmodSync(join(root, d), 0o777);
		}
		// A child Bun, because Bun resolves executables against the PATH it started with, not process.env.PATH.
		const layout = join(import.meta.dir, '../../../../src/lib/server/media/migrate-layout.ts');
		const child = Bun.spawnSync(
			[process.execPath, '-e', `const m = await import(${JSON.stringify(layout)}); m.ensureLayout();`],
			{ cwd: root, env: { MEDIA_DIR: root, PATH: join(root, 'no-chmod-here') }, stderr: 'pipe' }
		);
		expect(child.exitCode).toBe(0);
		// Bun >= 1.4.3 keeps the sticky bit through chmodSync; Bun 1.3 dropped it (#1222).
		for (const d of [root, join(root, 'derived')]) expect(statSync(d).mode & 0o7777).toBe(0o1775);
		expect(child.stderr.toString()).not.toContain('chmod 1775');
	});
});
