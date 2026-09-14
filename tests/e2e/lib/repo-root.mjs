import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The repo root, for e2e drivers.
 *
 * Every driver and probe under `tests/e2e/` needs the repo root — to spawn a server, to read a
 * source file, to check for a build directory. Deriving it by counting `..` hops from the file
 * doing the asking encodes that file's distance from the root, which is wrong the moment the tree
 * moves. It moved once already (the e2e tree went under `tests/`), and six probes were left
 * resolving one hop short, to `tests/` instead of the root. Nothing caught it: they are all on
 * `e2e-reachability`'s UNRUN list, and the guard that bans self-anchored paths reads only
 * `*.test.ts`, so no `.mjs` file was ever in its scope.
 *
 * So: walk up for a marker instead of counting. `bunfig.toml` is the marker rather than
 * `package.json` (which every workspace member has) or `.git` (absent in a worktree export, and
 * this repo is worked on in worktrees). It is also the file whose location bun itself uses to
 * resolve the test preload, so this module, the test harness (`@encore/test-support`) and the
 * worker's Python `_repo_root()` all agree on the root by construction.
 *
 * This is a plain relative `.mjs` import on purpose. Drivers run under bare `bun run` with no
 * bundler, so the `@encore/test-support` alias does not resolve at runtime — which is why five
 * separate copies of this walk had been inlined across the e2e tree. A relative import has no
 * such problem, and one copy cannot drift from another.
 *
 * Because it is a walk and not a hop count, this module can anchor on its OWN location and export
 * the result: moving this file does not change the answer.
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
