import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The repo root, by WALKING UP for a marker rather than counting `..` hops — see docs/E2E.md#shared-helpers.
 *
 * `bunfig.toml` is the marker rather than `package.json` (every workspace member has one) or `.git` (absent
 * in a worktree export, and this repo is worked on in worktrees). It is also what bun uses to resolve the
 * test preload, so this module, `@encore/test-support` and the worker's `_repo_root()` agree by
 * construction.
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

export const repoRoot = findRepoRoot();

/** @param {...string} segments @returns {string} */
export function atRepo(...segments) {
	return join(repoRoot, ...segments);
}
