import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The repo root, for e2e drivers — found by WALKING UP for a marker, never by counting `..` hops, which
 * encodes the asking file's distance from the root and left six probes resolving one hop short when this
 * tree moved under `tests/`. Because it is a walk, this module anchors on its OWN location and moving it
 * does not change the answer.
 *
 * `bunfig.toml` is the marker rather than `package.json` (every workspace member has one) or `.git`
 * (absent in a worktree export, and this repo is worked on in worktrees). It is also what bun uses to
 * resolve the test preload, so this module, `@encore/test-support` and the worker's Python `_repo_root()`
 * agree by construction.
 *
 * A plain relative `.mjs` import on purpose: drivers run under bare `bun run` with no bundler, so the
 * `@encore/test-support` alias does not resolve at runtime.
 */
function findRepoRoot() {
	let dir = import.meta.dirname;
	for (let hops = 0; hops < 12; hops += 1) {
		if (existsSync(join(dir, 'bunfig.toml'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		`tests/e2e/lib/repo-root.mjs: could not find the repo root.\n` +
			`Walked up from ${import.meta.dirname} looking for bunfig.toml and never found one.\n` +
			`Run e2e drivers from inside the repo.`
	);
}

/** Absolute path to the repo root. */
export const repoRoot = findRepoRoot();

/**
 * Join path segments onto the repo root.
 * @param {...string} segments
 * @returns {string}
 */
export function atRepo(...segments) {
	return join(repoRoot, ...segments);
}
