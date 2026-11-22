// ui-review-media.ts commits in a throwaway clone, which has no local config: its commits must still carry the
// identity of the clone it runs from, never the machine's global one, because the branch is public.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, '../../playwright/ui-review-media.ts');
const NOREPLY = '22626742+OnlyOneByte@users.noreply.github.com';
const OWNER = `OnlyOneByte <${NOREPLY}>`;
const WORK = 'someone@work.example';
let root = '';
let globalConfig = '';
let env: NodeJS.ProcessEnv = {};
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const run = (cwd: string, ...args: string[]) => spawnSync('bun', [script, ...args], { cwd, env, encoding: 'utf8' });
const bare = () => join(root, 'origin.git');
const who = (rev: string) => git(['log', '-1', '--format=%an <%ae>|%cn <%ce>', rev], bare());

/** A source clone whose LOCAL identity is `name <email>` (no local name when null), with origin a local bare
 *  repo, and one media row. */
function source(name: string | null, email: string) {
	const src = join(root, 'src');
	git(['init', '--quiet', '--bare', bare()], root);
	git(['init', '--quiet', src], root);
	if (name !== null) git(['config', 'user.name', name], src);
	git(['config', 'user.email', email], src);
	git(['remote', 'add', 'origin', bare()], src);
	const row = join(root, 'motion', 'row');
	mkdirSync(row, { recursive: true });
	for (const f of ['clip.gif', 'filmstrip.png', 'metrics.json']) writeFileSync(join(row, f), f);
	return src;
}

function publishesAsOwner(src: string) {
	const r = run(src, 'publish', '7', 'row');
	expect([r.status, r.stderr]).toEqual([0, expect.any(String)]);
	expect(who('ui-review-media')).toBe(`${OWNER}|${OWNER}`);
}

function publishesNothing(src: string) {
	const r = run(src, 'publish', '7', 'row');
	expect([r.status, r.stderr]).toEqual([1, expect.stringContaining('need a GitHub noreply identity')]);
	expect(git(['branch', '--list'], bare())).toBe('');
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'ui-review-media-test-'));
	// The machine's global identity is a work email: that is the one that must never reach the branch.
	globalConfig = join(root, 'global.gitconfig');
	writeFileSync(globalConfig, `[user]\n\tname = Work Name\n\temail = ${WORK}\n`);
	env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', MOTION_OUT: join(root, 'motion') };
	// Nothing the runner exported may decide the identity: not the identity vars, not env-injected config.
	for (const k of Object.keys(env))
		if (/^GIT_(AUTHOR|COMMITTER)_|^GIT_CONFIG_(COUNT|KEY_|VALUE_|PARAMETERS)/.test(k)) delete env[k];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('publish and prune commit as the source clone, not the global identity', () => {
	const src = source('OnlyOneByte', NOREPLY);
	// The first publish starts the orphan branch, the second clones it, and prune re-roots it: three commits.
	for (const args of [
		['publish', '7', 'row'],
		['publish', '8', 'row'],
		['prune', '--keep', '8', '--apply']
	]) {
		const r = run(src, ...args);
		expect([r.status, r.stderr]).toEqual([0, expect.any(String)]);
		expect(who('ui-review-media')).toBe(`${OWNER}|${OWNER}`);
	}
});

test('GIT_AUTHOR_* / GIT_COMMITTER_* in the environment do not override the identity', () => {
	const src = source('OnlyOneByte', NOREPLY);
	for (const k of ['AUTHOR', 'COMMITTER']) {
		env[`GIT_${k}_NAME`] = 'Work Name';
		env[`GIT_${k}_EMAIL`] = WORK;
	}
	publishesAsOwner(src);
});

test('a global [author]/[committer] identity does not reach the commit', () => {
	const src = source('OnlyOneByte', NOREPLY);
	appendFileSync(globalConfig, `[author]\n\tname = Work Name\n\temail = ${WORK}\n[committer]\n\temail = ${WORK}\n`);
	publishesAsOwner(src);
});

test('an author.email injected through GIT_CONFIG_COUNT does not reach the commit', () => {
	const src = source('OnlyOneByte', NOREPLY);
	Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'author.email', GIT_CONFIG_VALUE_0: WORK });
	publishesAsOwner(src);
});

test('a commit rewritten after the env pin (a global post-commit hook) is refused before the push', () => {
	const src = source('OnlyOneByte', NOREPLY);
	// The one route past the env pin: a hook that amends the author once the commit exists.
	const hooks = join(root, 'hooks');
	mkdirSync(hooks);
	const hook = `#!/bin/sh\n[ -n "$AMENDED" ] && exit 0\nAMENDED=1 GIT_AUTHOR_EMAIL=${WORK} git commit -q --amend --no-edit --reset-author\n`;
	writeFileSync(join(hooks, 'post-commit'), hook, { mode: 0o755 });
	appendFileSync(globalConfig, `[core]\n\thooksPath = ${hooks}\n`);
	const r = run(src, 'publish', '7', 'row');
	expect([r.status, r.stderr]).toEqual([1, expect.stringContaining('not pushed')]);
	expect(git(['branch', '--list'], bare())).toBe('');
});

test('a clone with no local user.name publishes nothing, even when the global config has one', () => {
	publishesNothing(source(null, NOREPLY));
});

test('a clone whose email is not a noreply address publishes nothing', () => {
	publishesNothing(source('Someone', WORK));
});

test('a work address dressed up around the noreply domain publishes nothing', () => {
	for (const email of [`${WORK}@users.noreply.github.com`, 'x@users.noreply.github.com.evil.com']) {
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root);
		writeFileSync(globalConfig, `[user]\n\tname = Work Name\n\temail = ${WORK}\n`);
		publishesNothing(source('OnlyOneByte', email));
	}
});
