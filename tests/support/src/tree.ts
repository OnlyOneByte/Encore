// unit: the one place a test says WHERE a file is, so no test has to say where it ITSELF is.
//
// THE PROBLEM THIS EXISTS TO DELETE. 130 test files reach their subject by counting `../` from their own
// location — `join(import.meta.dir, '..', '..', 'routes', 'tv', '+page.svelte')` and 207 siblings like it,
// at depths from 0 to 5. Every one of those is a statement about where the TEST lives, embedded in a
// statement about where the SOURCE lives. Move the test and the arithmetic is wrong.
//
// WHY THAT IS DANGEROUS AND NOT MERELY TEDIOUS. Roughly half the suite reads source as text to assert a
// convention. When such a guard's path is wrong it does not always error — if anything gates on
// `existsSync` it reads nothing, finds no violations, and PASSES. This repo has no CI, so a local run is
// the only gate, and a vacuously passing guard is indistinguishable from a healthy one. That failure has
// already happened here: `non-vacuity-floors.test.ts`'s RETIRED arm skipped silently on a missing file
// until phase 0 of the test reorganisation closed it.
//
// THE CONTRACT. Anchors are discovered by walking UP to the repo root marker, never by counting down from
// a caller. So a test importing this resolves the same paths from `apps/core/src/lib/`, from `tests/unit/`,
// or from anywhere else — which is what makes the move mechanical instead of 207 individual
// recalculations, and what stops the NEXT move from being a project.
//
// WHY THERE IS NO `readIfExists`. A missing path is always an error here, never a skip. A permissive
// variant would reproduce the RETIRED hole at 130x scale: every guard that lost its subject would quietly
// examine nothing. If a caller genuinely needs to tolerate absence it must say so at its own call site,
// where a reviewer can see the decision, and it must carry a non-vacuity floor (XR-VER-05).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The repo root, found by walking up for `bunfig.toml`.
 *
 * `bunfig.toml` is the marker rather than `package.json` (which every workspace member has) or `.git`
 * (absent in a worktree export, and this repo is worked on in worktrees). It is also the file whose
 * location bun itself uses to resolve the test preload, so anchoring on it means this module and the test
 * runner agree on where the root is by construction.
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

/*
 * SELF-CHECK, on load, once.
 *
 * A wrong anchor must be loud exactly once rather than silently wrong at 207 call sites. Each assertion
 * below names a landmark that cannot plausibly be absent from a correct root, so this fires on a
 * misresolution rather than on an ordinary refactor.
 */
for (const landmark of ['bunfig.toml', 'package.json', 'apps/core', 'apps/core/src/shared']) {
	if (!existsSync(join(repoRoot, landmark))) {
		throw new Error(
			`@encore/test-support: resolved repoRoot to ${repoRoot}, but it has no ${landmark}.\n` +
				'That is not the Encore repo root, so every path derived from it would be wrong. This throws ' +
				'now, once, instead of letting a few hundred guards read nothing and report green.'
		);
	}
}

/** `apps/core` — the SvelteKit app package. */
export const appCore: string = join(repoRoot, 'apps', 'core');
/** `apps/core/src` — where routes, lib and server live. */
export const appSrc: string = join(appCore, 'src');
/** `tests/e2e` — drivers, probes, gates and the selector contract. */
/**
 * `tests/e2e` — the browser-driving drivers, probes and gates.
 *
 * NOT under `apps/core` any more, despite the name. These lived at `apps/core/e2e` until the test
 * reorganisation moved every test out of the source tree; the export keeps its name because 13 guards
 * import it and the thing it names has not changed, only its address. When it moved, all 13 failed with
 * `ENOENT: scandir apps/core/e2e` — loudly, and from one place, which is the whole argument for a named
 * anchor over 13 copies of a path.
 */
export const appE2e: string = join(repoRoot, 'tests', 'e2e');
/** `apps/core/src/shared/src` — the domain code both the app and (by hand-mirroring) the worker use. */
/**
 * The ISOMORPHIC contract — code imported by both `src/lib` (client) and `src/server` (authoritative).
 *
 * Was `packages/shared/src` as its own workspace package; folded into the app as `apps/core/src/shared`.
 * The export keeps its name because the thing it names has not changed, only its address — and because a
 * named anchor is why this move needed ONE edit here instead of one per consumer.
 */
export const sharedSrc: string = join(appSrc, 'shared');
/** `apps/worker` — the Python side. Layer 1B. */
export const worker: string = join(repoRoot, 'apps', 'worker');

/** An absolute path from a repo-relative one. Does not check existence — see `read`. */
export function at(...parts: string[]): string {
	return join(repoRoot, ...parts);
}

/**
 * Read a repo-relative file. **Throws** when it is missing — deliberately, always.
 *
 * The error names the caller so a broken path is diagnosed as a broken path rather than as a failure of
 * whatever invariant the caller was asserting. That distinction is what `task-number-hygiene.test.ts`
 * lacks today: when its self-reference breaks it reds with a task-number message, which invites a fix that
 * silently widens the exemption.
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
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const p = join(dir, entry);
			if (statSync(p).isDirectory()) walk(p);
			else if (exts.some((e) => entry.endsWith(e))) out.push(p);
		}
	};
	walk(root);
	return out.sort();
}

/** A repo-relative path from an absolute one, for stable failure messages that do not leak a machine path. */
export function relative(abs: string): string {
	const r = resolve(abs);
	return r.startsWith(repoRoot) ? r.slice(repoRoot.length + 1) : r;
}
