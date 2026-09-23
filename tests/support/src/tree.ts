// The one place a test says WHERE a file is, so no test has to say where it ITSELF is.
//
// Anchors are found by walking UP to the repo root marker, never by counting `../` down from a caller: a path that
// encodes the TEST's location inside a claim about the SOURCE's location is wrong the moment either moves. A wrong path
// does not always error — anything gating on `existsSync` reads nothing, finds no violations, and PASSES, which is
// indistinguishable from a healthy guard.
//
// Hence no `readIfExists`: a missing path is always an error, never a skip. A caller that must tolerate absence says so
// at its own call site, where a reviewer can see it, and carries a non-vacuity floor.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * The repo root, found by walking up for `bunfig.toml` — the marker rather than `package.json` (every workspace member
 * has one) or `.git` (absent in a worktree export, and this repo is worked on in worktrees). It is also what bun uses to
 * resolve the test preload, so this module and the runner agree on the root by construction.
 */
function findRepoRoot(): string {
	let dir = import.meta.dir;
	for (let hops = 0; hops < 12; hops++) {
		if (existsSync(join(dir, 'bunfig.toml'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		'@encore/test-support: could not find the repo root.\n' +
			`Walked up from ${import.meta.dir} looking for bunfig.toml and never found one.\n` +
			'Every anchor in this module is derived from that file, so nothing here can be trusted until it ' +
			'resolves. If the repo layout moved, fix it HERE rather than in the callers — that centralisation ' +
			'is the whole point of this module.'
	);
}

export const repoRoot: string = findRepoRoot();

// Self-check, on load, once: a wrong anchor must be loud exactly once rather than silently wrong at every call site.
// No landmark below can plausibly be absent from a correct root, so this fires on a misresolution, not on a refactor.
for (const landmark of ['bunfig.toml', 'package.json', '.', 'src/lib/contract']) {
	if (!existsSync(join(repoRoot, landmark))) {
		throw new Error(
			`@encore/test-support: resolved repoRoot to ${repoRoot}, but it has no ${landmark}.\n` +
				'That is not the Encore repo root, so every path derived from it would be wrong. This throws ' +
				'now, once, instead of letting a few hundred guards read nothing and report green.'
		);
	}
}

/** `src` — where routes, lib and server live. */
export const srcDir: string = join(repoRoot, 'src');
/** `tests/e2e` — the browser-driving drivers, probes, gates and the selector contract. */
export const e2eDir: string = join(repoRoot, 'tests', 'e2e');
/** The ISOMORPHIC contract — code imported by both `src/lib` (client) and `src/lib/server`. */
export const sharedSrc: string = join(srcDir, 'lib', 'contract');
/**
 * `worker` — the Python side.
 * @knipignore Deliberately has no consumer yet; it completes the path-anchor set, which is why a move costs ONE edit.
 */
export const worker: string = join(repoRoot, 'worker');

/** An absolute path from a repo-relative one. Does not check existence — see `read`. */
export function at(...parts: string[]): string {
	return join(repoRoot, ...parts);
}

/**
 * Read a repo-relative file. **Throws** when it is missing — deliberately, always, naming the caller, so a broken path
 * is diagnosed as one rather than as a failure of the invariant the caller was asserting.
 */
export function read(...parts: string[]): string {
	const abs = at(...parts);
	if (!existsSync(abs)) {
		throw new Error(
			`@encore/test-support: no file at ${parts.join('/')} (resolved to ${abs}).\n` +
				'This is a PATH failure, not a failure of the invariant being asserted — fix the path, and do ' +
				'not convert this into a skip. A guard that tolerates a missing subject asserts nothing.'
		);
	}
	return readFileSync(abs, 'utf8');
}

/**
 * Directories no source walk may descend into: `build/`, `.svelte-kit/` and `dist/` hold BUILT COPIES, so a walk that
 * reaches them reports on code the app no longer runs. There is deliberately no INCLUDE allowlist — every walk is
 * unconditionally recursive, so a new source directory is in scope by construction.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'build', '.svelte-kit', 'dist', '.git']);

/**
 * THE recursive walk. Every file-listing helper here is a filter over this one function, so scope has one definition.
 *
 * `withFileTypes` rather than a `statSync` per entry: fewer syscalls, and it does not follow symlinks, so a symlinked
 * directory cannot make the walk leave the tree it was pointed at. Sorted, ALWAYS — `readdirSync` order is
 * filesystem-dependent, so an unsorted walk makes an order-sensitive assertion pass or fail per machine.
 */
function walkDir(dir: string, keep: (name: string) => boolean): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			out.push(...walkDir(p, keep));
		} else if (keep(entry.name)) out.push(p);
	}
	return out;
}

/** Every file under a repo-relative directory, recursively, with the given extensions. Sorted, absolute. */
export function filesUnder(rel: string, exts: readonly string[]): string[] {
	const root = at(rel);
	if (!existsSync(root)) {
		throw new Error(
			`@encore/test-support: no directory at ${rel} (resolved to ${root}).\n` +
				'A walk over a missing root yields an empty list, which reads exactly like a clean tree. ' +
				'Throwing keeps that from becoming a vacuous pass.'
		);
	}
	return filesIn(root, exts);
}

/**
 * Every file under an ABSOLUTE directory, recursively, with the given extensions. Sorted. Same walk, skip set and
 * ordering as `filesUnder`; it exists because the `.svelte` helpers are handed an already-resolved directory.
 */
export function filesIn(dir: string, exts: readonly string[]): string[] {
	if (!existsSync(dir)) {
		throw new Error(
			`@encore/test-support: no directory at ${dir}.\n` +
				'A walk over a missing root yields an empty list, which reads exactly like a clean tree. ' +
				'Throwing keeps that from becoming a vacuous pass.'
		);
	}
	return walkDir(dir, (name) => exts.some((e) => name.endsWith(e))).sort();
}

/** A repo-relative path from an absolute one, for stable failure messages that do not leak a machine path. */
export function relative(abs: string): string {
	const r = resolve(abs);
	return r.startsWith(repoRoot) ? r.slice(repoRoot.length + 1) : r;
}
