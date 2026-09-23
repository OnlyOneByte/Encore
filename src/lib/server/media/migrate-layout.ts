// One-shot storage-layout migration to the classes in docs/ARCHITECTURE.md §6 (#media-storage-and-paths).
// Runs at boot before the catalog is read. IDEMPOTENT — safe to leave wired in forever. Promotes
// legacy scratch-retained raw audio into `audio/` (unregenerable) and moves legacy derived artifacts
// under `derived/`, rewriting DB refs in the same pass.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { mediaRoot, audioDir, derivedDir, metaDir, workDir, LEGACY } from './paths';

export interface MigrationPlan {
	moves: Array<[string, string]>; // [absolute from, absolute to]
	prunes: string[]; // absolute dirs to remove once their contents are moved
	refRewrites: Map<string, Record<string, string>>; // mediaId → { field: newRef }
}

export interface MigrationResult {
	moved: number;
	bytesMoved: number;
	pruned: number;
	refsRewritten: number;
	skipped: number;
	copiedInPlace: number; // moved by copy: source could not be removed (container-owned dir)
	failed: number; // could not be moved at all; the migration continues past these
	failures: Array<{ from: string; to: string; reason: string }>;
	alreadyMigrated: boolean;
}

// Rename first (instant, atomic, same-device); on failure, copy + best-effort unlink instead — a
// container-written bind mount may deny the write permission rename needs though the file is
// readable, and preserving `audio/` (unrecoverable) matters more than throwing.
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

// Work out what needs moving. Only READS — nothing moves until `applyMigration` runs, which is what
// makes this inspectable and testable.
export function planMigration(root = mediaRoot()): MigrationPlan {
	const moves: Array<[string, string]> = [];
	const prunes: string[] = [];
	const refRewrites = new Map<string, Record<string, string>>();

	const addRewrite = (mediaId: string, field: string, ref: string) => {
		refRewrites.set(mediaId, { ...(refRewrites.get(mediaId) ?? {}), [field]: ref });
	};

	// 1. raw audio out of the scratch dir
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
		prunes.push(legacyWork);
	}

	// 2. derived artifacts into the derived class
	for (const [legacyDir, derivedSub, field] of [
		['stems', 'stems', null],
		['lyrics', 'lyrics', 'lyricsRef']
	] as Array<[string, string, string | null]>) {
		const abs = join(root, legacyDir);
		if (!existsSync(abs)) continue;
		for (const file of listFiles(abs)) {
			const name = basename(file);
			moves.push([file, join(derivedDir(), derivedSub, name)]);
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

	// 3. thumb cache
	const legacyThumbs = join(root, LEGACY.thumbs);
	for (const file of listFiles(legacyThumbs)) {
		moves.push([file, join(derivedDir(), 'thumbs', basename(file))]);
	}
	if (existsSync(legacyThumbs)) prunes.push(legacyThumbs);

	return { moves, prunes, refRewrites };
}

// Execute a plan. `rewriteRefs` is injected (not imported) so this unit-tests with no database, and
// so the caller owns transaction boundaries.
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
		if (existsSync(to)) {
			res.skipped++; // never clobber: an existing destination means a previous run already placed it
			continue;
		}
		const bytes = sizeOf(from);
		// Per-file isolation: one unmovable file (mixed-ownership volume) must not abort the rest.
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

	// Prune only after moves, and only if now empty — a non-empty dir holds data this migration
	// doesn't understand, and must not be deleted.
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
 * Core and worker are separate containers at DIFFERENT uids on the same mounted volume; whichever
 * process creates a dir owns it, so a 0755 dir made by one is unwritable by the other. Worker-written
 * dirs are therefore created world-writable (`mkdirSync`'s mode is masked by umask, hence the
 * explicit chmod). `meta/` stays restrictive and core-only — the authoritative record, not a drop box.
 */
export function ensureLayout(): void {
	const shared = [
		// worker-written: raw downloads, stems, pitch tracks, lyrics, job scratch
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
			/* pre-existing dir owned by another uid — already works or already doesn't */
		}
	}
	// Parents too, traversable+writable, so a worker can create a missing subdir itself.
	for (const dir of [mediaRoot(), derivedDir()]) {
		mkdirSync(dir, { recursive: true });
		try {
			chmodSync(dir, 0o777);
		} catch {
			/* best effort */
		}
	}
	mkdirSync(metaDir(), { recursive: true }); // core-only: the authoritative sidecar records
}

// Boot entry: create the layout, migrate anything legacy, return a result the caller can log.
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

// Remove a finished job's scratch dir. Best-effort — never fails a completed job over it.
export function cleanJobWork(jobId: string): void {
	const dir = join(workDir(), jobId);
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}
