// ui-review-media.ts commits in a throwaway clone, which has no local config: its commits must still carry the
// identity of the clone it runs from, never the machine's global one, because the branch is public.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, '../../playwright/ui-review-media.ts');
const OWNER = 'OnlyOneByte <22626742+OnlyOneByte@users.noreply.github.com>';
let root = '';
let env: NodeJS.ProcessEnv = {};
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const run = (cwd: string, ...args: string[]) => spawnSync('bun', [script, ...args], { cwd, env, encoding: 'utf8' });
const who = (bare: string, rev: string) => git(['log', '-1', '--format=%an <%ae>|%cn <%ce>', rev], bare);

/** A source clone whose local identity is `name <email>`, with origin a local bare repo, and one media row. */
function source(name: string, email: string) {
	const src = join(root, 'src');
	git(['init', '--quiet', '--bare', join(root, 'origin.git')], root);
	git(['init', '--quiet', src], root);
	git(['config', 'user.name', name], src);
	git(['config', 'user.email', email], src);
	git(['remote', 'add', 'origin', join(root, 'origin.git')], src);
	const row = join(root, 'motion', 'row');
	mkdirSync(row, { recursive: true });
	for (const f of ['clip.gif', 'filmstrip.png', 'metrics.json']) writeFileSync(join(row, f), f);
	return src;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'ui-review-media-test-'));
	// The machine's global identity is a work email: that is the one that must never reach the branch.
	const global = join(root, 'global.gitconfig');
	writeFileSync(global, '[user]\n\tname = Work Name\n\temail = someone@work.example\n');
	env = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1', MOTION_OUT: join(root, 'motion') };
	for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete env[k];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('publish and prune commit as the source clone, not the global identity', () => {
	const src = source('OnlyOneByte', '22626742+OnlyOneByte@users.noreply.github.com');
	const bare = join(root, 'origin.git');
	// The first publish starts the orphan branch, the second clones it, and prune re-roots it: three commits.
	for (const args of [
		['publish', '7', 'row'],
		['publish', '8', 'row'],
		['prune', '--keep', '8', '--apply']
	]) {
		const r = run(src, ...args);
		expect([r.status, r.stderr]).toEqual([0, expect.any(String)]);
		expect(who(bare, 'ui-review-media')).toBe(`${OWNER}|${OWNER}`);
	}
});

test('GIT_AUTHOR_* / GIT_COMMITTER_* in the environment do not override the identity', () => {
	const src = source('OnlyOneByte', '22626742+OnlyOneByte@users.noreply.github.com');
	for (const k of ['AUTHOR', 'COMMITTER']) {
		env[`GIT_${k}_NAME`] = 'Work Name';
		env[`GIT_${k}_EMAIL`] = 'someone@work.example';
	}
	const r = run(src, 'publish', '7', 'row');
	expect([r.status, r.stderr]).toEqual([0, expect.any(String)]);
	expect(who(join(root, 'origin.git'), 'ui-review-media')).toBe(`${OWNER}|${OWNER}`);
});

test('a clone whose email is not a noreply address publishes nothing', () => {
	const src = source('Someone', 'someone@work.example');
	const r = run(src, 'publish', '7', 'row');
	expect(r.status).toBe(1);
	expect(r.stderr).toContain('need a GitHub noreply identity');
	expect(git(['branch', '--list'], join(root, 'origin.git'))).toBe('');
});
