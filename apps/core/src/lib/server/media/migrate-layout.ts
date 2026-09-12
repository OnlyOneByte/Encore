// One-shot storage-layout migration to the storage classes.
//
// Runs at boot, before anything reads the catalog. IDEMPOTENT: a fresh and an already-migrated volume
// are both no-ops, so it is safe to leave wired in forever.
//
// What it fixes on a real volume (measured on the live box, 2026-09-02):
//   - `stems/_work/<id>/source.wav` — 432MB of RAW ORIGINAL AUDIO retained by accident in a scratch
//     dir nothing cleaned. It is the one asset that cannot be regenerated, so it is PROMOTED to
//     `audio/<id>.wav` rather than deleted with the rest of the scratch.
//   - `stems/*`, `pitch/*`, `lyrics/*`, `.thumbs/*` → under `derived/` (the evictable class,
//     recomputable from `audio/`).
//   - DB refs rewritten in the same pass so `instrumentalRef`/`lyricsRef` keep pointing at
//     real files. A half-migrated convention is the byte-for-byte mismatch that makes the TV 404 on a
//     file that exists.
//
// Moves use rename() and fall back to copy+unlink across devices (a class pointed at another volume).

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { mediaRoot, audioDir, derivedDir, metaDir, workDir, LEGACY } from './paths';

export interface MigrationPlan {
	/** [absolute from, absolute to] */
	moves: Array<[string, string]>;
	/** absolute dirs to remove once their contents are moved */
	prunes: string[];
	/** mediaId → { field: newRef } rewrites for the DB */
	refRewrites: Map<string, Record<string, string>>;
}

export interface MigrationResult {
	moved: number;
	bytesMoved: number;
	pruned: number;
	refsRewritten: number;
	skipped: number;
	/** Moved by copy because the source could not be removed (container-owned scratch dir). */
	copiedInPlace: number;
	/** Files that could not be moved at all. The migration continues past them. */
	failed: number;
	failures: Array<{ from: string; to: string; reason: string }>;
	alreadyMigrated: boolean;
}

/**
 * Move one file, creating the parent.
 *
 * Rename first (instant, atomic, same-device). On ANY rename failure fall back to copy + best-effort
 * unlink — the interesting failure is not just cross-device: a bind-mounted volume a CONTAINER wrote is
 * owned by the container's uid, and renaming a file OUT of a dir needs write permission on that dir,
 * which we may not have. Copying still succeeds (the file is readable) and preserves the asset — the
 * whole point for `audio/`. Preferring partial success over an exception is deliberate: losing the only
 * unrecoverable class to a permission bit is the worse outcome.
 *
 * @returns 'renamed' | 'copied' (source could not be removed) — throws only if the copy also failed.
 */
function moveFile(from: string, to: string): 'renamed' | 'copied' {
	mkdirSync(dirname(to), { recursive: true });
	try {
		renameSync(from, to);
		return 'renamed';
	} catch {
		copyFileSync(from, to);
		try {
			rmSync(from, { force: true });
			return 'renamed';
		} catch {
			return 'copied'; // the bytes are safe; the stale source stays and prune will skip it
		}
	}
}

function sizeOf(p: string): number {
	try {
		return statSync(p).size;
	} catch {
		return 0;
	}
}

function listFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isFile())
			.map((d) => join(dir, d.name));
	} catch {
		return [];
	}
}

/**
 * Work out what needs moving. PURE with respect to the filesystem in the sense that it only READS —
 * nothing is moved until `applyMigration` runs, which is what makes this inspectable and testable.
 */
export function planMigration(root = mediaRoot()): MigrationPlan {
	const moves: Array<[string, string]> = [];
	const prunes: string[] = [];
	const refRewrites = new Map<string, Record<string, string>>();

	const addRewrite = (mediaId: string, field: string, ref: string) => {
		refRewrites.set(mediaId, { ...(refRewrites.get(mediaId) ?? {}), [field]: ref });
	};

	// ── 1. raw audio out of the scratch dir (the 432MB) ───────────────────────────────
	const legacyWork = join(root, LEGACY.workRoot);
	if (existsSync(legacyWork)) {
		let entries: string[];
		try {
			entries = readdirSync(legacyWork, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name);
		} catch {
			entries = [];
		}
		for (const mediaId of entries) {
			const src = join(legacyWork, mediaId, 'source.wav');
			if (existsSync(src)) {
				moves.push([src, join(audioDir(), `${mediaId}.wav`)]);
				addRewrite(mediaId, 'audioRef', `audio/${mediaId}.wav`);
			}
		}
		// whatever else was in scratch is genuinely scratch
		prunes.push(legacyWork);
	}

	// ── 2. derived artifacts into the derived class ────────────────────────────────────
	for (const [legacyDir, derivedSub, field] of [
		['stems', 'stems', null],
		['lyrics', 'lyrics', 'lyricsRef']
	] as Array<[string, string, string | null]>) {
		const abs = join(root, legacyDir);
		if (!existsSync(abs)) continue;
		for (const file of listFiles(abs)) {
			const name = basename(file);
			moves.push([file, join(derivedDir(), derivedSub, name)]);
			// derive the mediaId + field from the filename convention
			if (derivedSub === 'stems') {
				const m = /^(.+)-(instrumental|vocals)\.wav$/.exec(name);
				if (m && m[2] === 'instrumental') addRewrite(m[1], 'instrumentalRef', `derived/stems/${name}`);
			} else if (field) {
				const m = /^(.+?)(?:-pitch)?\.json$/.exec(name);
				if (m) addRewrite(m[1], field, `derived/${derivedSub}/${name}`);
			}
		}
		prunes.push(abs);
	}

	// ── 3. thumb cache ────────────────────────────────────────────────────────────────
	const legacyThumbs = join(root, LEGACY.thumbs);
	for (const file of listFiles(legacyThumbs)) {
		moves.push([file, join(derivedDir(), 'thumbs', basename(file))]);
	}
	if (existsSync(legacyThumbs)) prunes.push(legacyThumbs);

	return { moves, prunes, refRewrites };
}

/**
 * Execute a plan. `rewriteRefs` is injected (rather than importing the DB) so this unit-tests against
 * a real temp filesystem with no database, and so the caller owns transaction boundaries.
 */
export function applyMigration(
	plan: MigrationPlan,
	rewriteRefs?: (mediaId: string, fields: Record<string, string>) => void
): MigrationResult {
	const res: MigrationResult = {
		moved: 0,
		bytesMoved: 0,
		pruned: 0,
		refsRewritten: 0,
		skipped: 0,
		copiedInPlace: 0,
		failed: 0,
		failures: [],
		alreadyMigrated: false
	};

	for (const [from, to] of plan.moves) {
		if (!existsSync(from)) {
			res.skipped++;
			continue;
		}
		// Never clobber: an existing destination means a previous run already placed it.
		if (existsSync(to)) {
			res.skipped++;
			continue;
		}
		const bytes = sizeOf(from);
		// Per-file isolation: ONE unmovable file must not abandon the rest of the migration. A volume
		// with mixed ownership (some files written by a container) would otherwise strand everything
		// after the first failure.
		try {
			const how = moveFile(from, to);
			res.moved++;
			res.bytesMoved += bytes;
			if (how === 'copied') res.copiedInPlace++;
		} catch (err) {
			res.failed++;
			res.failures.push({ from, to, reason: (err as Error).message });
		}
	}

	for (const [mediaId, fields] of plan.refRewrites) {
		rewriteRefs?.(mediaId, fields);
		res.refsRewritten++;
	}

	// Prune only AFTER moves, and only if the dir is now empty of files (a non-empty dir means
	// something unexpected lives there and deleting it would be destroying data we do not understand).
	for (const dir of plan.prunes) {
		if (!existsSync(dir)) continue;
		try {
			if (listFiles(dir).length > 0) {
				res.skipped++;
				continue;
			}
			rmSync(dir, { recursive: true, force: true });
			res.pruned++;
		} catch {
			res.skipped++;
		}
	}

	return res;
}

/**
 * Ensure every class dir exists (cheap, idempotent) so the first write never races a missing dir.
 *
 * SHARED-WRITE MODE. Core and worker are separate containers running as DIFFERENT uids on the same
 * mounted volume (compose mounts `${ENCORE_MEDIA_VOLUME}:/app/media` into both). Whichever process
 * creates a dir owns it, and a 0755 dir created by the core is unwritable by the worker — exactly how
 * the layout migration first broke every cook (worker got `Permission denied: /app/media/work/<jobId>`
 * on dirs the core had just made). The old layout only worked because its dirs were chmod'd by hand.
 *
 * So worker-written dirs are created world-writable. `mkdirSync`'s mode is masked by umask, hence the
 * explicit separate chmod. `meta/` is core-only and stays restrictive — the authoritative record, not
 * a drop box.
 *
 * Rejected alternative: build both images with a shared group + setgid dirs — worth doing if Encore
 * ever runs somewhere less trusted than a living room (noted in docs/ARCHITECTURE.md).
 */
export function ensureLayout(): void {
	// worker-written: raw downloads, stems, pitch tracks, lyrics, job scratch
	const shared = [
		audioDir(),
		join(derivedDir(), 'stems'),
		join(derivedDir(), 'pitch'),
		join(derivedDir(), 'lyrics'),
		join(derivedDir(), 'thumbs'),
		workDir()
	];
	for (const dir of shared) {
		mkdirSync(dir, { recursive: true });
		try {
			chmodSync(dir, 0o777);
		} catch {
			/* not ours to chmod (pre-existing dir owned by another uid) — it already works or already doesn't */
		}
	}
	// also make the parents traversable+writable so a worker can create a missing subdir itself
	for (const dir of [mediaRoot(), derivedDir()]) {
		mkdirSync(dir, { recursive: true });
		try {
			chmodSync(dir, 0o777);
		} catch {
			/* best effort */
		}
	}
	// core-only: the authoritative sidecar records
	mkdirSync(metaDir(), { recursive: true });
}

/**
 * Boot entry: create the layout, migrate anything legacy, report what happened. Safe to call on
 * every start. Returns a result the caller can log — silence on a no-op volume.
 */
export function migrateStorageLayout(
	rewriteRefs?: (mediaId: string, fields: Record<string, string>) => void
): MigrationResult {
	ensureLayout();
	const plan = planMigration();
	if (plan.moves.length === 0 && plan.prunes.length === 0) {
		return {
			moved: 0,
			bytesMoved: 0,
			pruned: 0,
			refsRewritten: 0,
			skipped: 0,
			copiedInPlace: 0,
			failed: 0,
			failures: [],
			alreadyMigrated: true
		};
	}
	return applyMigration(plan, rewriteRefs);
}

/** Remove a finished job's scratch dir. Called on job completion, success or failure. */
export function cleanJobWork(jobId: string): void {
	const dir = join(workDir(), jobId);
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* scratch cleanup is best-effort — never fail a completed job over it */
	}
}
