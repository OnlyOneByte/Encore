// One-shot layout migration to the classes in docs/ARCHITECTURE.md §6, run at boot before the catalog is
// read. IDEMPOTENT, so it is safe to leave wired in forever. Promotes legacy scratch-retained raw audio into
// `audio/` and moves legacy derived artifacts under `derived/`, rewriting DB refs in the same pass.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	copyFileSync,
	chmodSync,
	realpathSync
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

/** An all-zero result. `alreadyMigrated` is the only field that ever differs between the two callers —
 *  `applyMigration`'s accumulator starts false, the nothing-to-do shortcut returns true. */
function emptyResult(alreadyMigrated: boolean): MigrationResult {
	return {
		moved: 0,
		bytesMoved: 0,
		pruned: 0,
		refsRewritten: 0,
		skipped: 0,
		copiedInPlace: 0,
		failed: 0,
		failures: [],
		alreadyMigrated
	};
}

// Rename first, then copy + best-effort unlink on failure: a container-written bind mount may deny the
// write permission rename needs though the file is readable, and preserving `audio/` beats throwing.
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

// READS ONLY: nothing moves until `applyMigration` runs, which is what makes this inspectable.
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
				if (m && m[2] === 'instrumental') addRewrite(m[1]!, 'instrumentalRef', `derived/stems/${name}`);
			} else if (field) {
				const m = /^(.+?)(?:-pitch)?\.json$/.exec(name);
				if (m) addRewrite(m[1]!, field, `derived/${derivedSub}/${name}`);
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

// `rewriteRefs` is INJECTED, so this unit-tests with no database and the caller owns the transaction.
export function applyMigration(
	plan: MigrationPlan,
	rewriteRefs?: (mediaId: string, fields: Record<string, string>) => void
): MigrationResult {
	const res: MigrationResult = emptyResult(false);

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
		// Per-file isolation: one unmovable file must not abort the rest.
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

	// Only after moves, and only if EMPTY: a non-empty dir holds data this migration does not understand.
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

/** rwxrwxr-x: core and its group write, everyone else only reads (#1206). */
export const SHARED_DIR_MODE = 0o775;
/** The same plus sticky, for the media root and `derived/`: the group may add entries but only an entry's owner
 *  may rename or remove it, so the worker cannot swap out core's `meta/` (or any other core dir). */
export const PARENT_DIR_MODE = 0o1775;
const OLD_BUN = Bun.semver.order(Bun.version, '1.4.3') < 0;

/** Set 1775 unless it already is, then a loud warning if it isn't, since a dir left 0777 or 0775 lets the worker
 *  swap core's dirs out. A dir already at 1775 is left alone: Bun 1.3's fs.chmod drops the sticky bit (#1222). */
function chmodParent(dir: string): void {
	if (leftAlone(dir) || modeOf(dir) === PARENT_DIR_MODE) return;
	try {
		chmodSync(dir, PARENT_DIR_MODE);
	} catch {
		/* not ours to change: reported below */
	}
	const now = modeOf(dir);
	if (now !== PARENT_DIR_MODE) {
		const cause = OLD_BUN ? `Bun ${Bun.version} drops the sticky bit; Bun >= 1.4.3 keeps it. ` : '';
		console.warn(
			`[core] ${dir} is ${now.toString(8)}, not 1775, so the worker can rename core's meta/ out of the way. ` +
				`${cause}Run: chmod 1775 ${dir}`
		);
	}
}

/** True, with a warning, for a dir that is or sits above the home dir, the temp dir or /, by real path: those
 *  are shared with everything else, so core never re-modes them (any MEDIA_DIR or ENCORE_*_DIR may point there). */
function leftAlone(dir: string): boolean {
	const real = realpathSync(dir);
	const above = real.endsWith('/') ? real : `${real}/`;
	if (![homedir(), tmpdir(), '/'].map(realpathOr).some((s) => s === real || s.startsWith(above))) return false;
	console.warn(`[core] ${dir} is a shared directory, so core leaves its mode alone. Give media its own dir.`);
	return true;
}

const modeOf = (dir: string) => statSync(dir).mode & 0o7777;
const realpathOr = (dir: string) => {
	try {
		return realpathSync(dir);
	} catch {
		return dir;
	}
};

/**
 * So the first write never races a missing dir. Core and worker are separate containers at DIFFERENT uids on
 * one volume, so the shared dirs are group-writable (core's group) rather than world-writable, and
 * compose adds the worker to that group. An explicit chmod because umask masks `mkdirSync`'s mode. `meta/`
 * stays restrictive and core-only: it is the authoritative record, not a drop box.
 */
export function ensureLayout(): void {
	const shared = [
		// Worker-written.
		audioDir(),
		join(derivedDir(), 'stems'),
		join(derivedDir(), 'pitch'),
		join(derivedDir(), 'lyrics'),
		join(derivedDir(), 'thumbs'),
		workDir()
	];
	for (const dir of shared) {
		mkdirSync(dir, { recursive: true });
		if (leftAlone(dir)) continue;
		try {
			chmodSync(dir, SHARED_DIR_MODE);
		} catch {
			/* pre-existing dir owned by another uid — already works or already doesn't */
		}
	}
	// Parents too, so a worker can create a missing subdir itself. Sticky only here: in the leaf dirs the worker
	// replaces its own files over ones core may have made, which a sticky bit would refuse.
	for (const dir of [mediaRoot(), derivedDir()]) {
		mkdirSync(dir, { recursive: true });
		chmodParent(dir);
	}
	// Core-only: the authoritative sidecar records. Set explicitly, since the worker shares core's group.
	mkdirSync(metaDir(), { recursive: true });
	if (leftAlone(metaDir())) return;
	try {
		chmodSync(metaDir(), 0o755);
	} catch {
		/* best effort */
	}
}

// Boot entry: create the layout, migrate anything legacy, return a loggable result.
export function migrateStorageLayout(
	rewriteRefs?: (mediaId: string, fields: Record<string, string>) => void
): MigrationResult {
	ensureLayout();
	const plan = planMigration();
	if (plan.moves.length === 0 && plan.prunes.length === 0) return emptyResult(true);
	return applyMigration(plan, rewriteRefs);
}

// Best-effort: never fails a completed job over it.
export function cleanJobWork(jobId: string): void {
	const dir = join(workDir(), jobId);
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}
