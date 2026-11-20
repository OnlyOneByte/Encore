// UI REVIEW MEDIA: put `bun run ui:review` output where a PR comment can show it, and keep that place small.
//
// `gh` cannot attach images to a PR, so the media lives on `ui-review-media`, an orphan branch that shares no
// history with main, and a PR comment links it (docs/UI-CHECKLIST.md#putting-the-gif-in-the-pr). Two commands:
//
//   bun run ui:review:publish-media -- <pr> [--dir <name>] [--slow] [row ...]
//       Copies each row's clip.gif and filmstrip.png (and metrics.json) to pr-<pr>/<dir>/<row>/, commits and
//       pushes without force, then prints the Markdown for the comment. Refuses a row whose media is over the cap.
//   bun run ui:review:prune-media -- [--keep <pr,pr>] [--apply]
//       Re-roots the branch as ONE new parentless commit holding only the kept PRs' folders, so every older
//       object stops being reachable. Dry-run unless --apply; the push is pinned to the commit it read.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BRANCH = 'ui-review-media';
const REMOTE_REF = `refs/remotes/origin/${BRANCH}`;
const REPO_URL = 'https://github.com/OnlyOneByte/Encore';
/** Per file. Two media files per row (the GIF and the strip) keeps a four-row PR under about 12 MB. */
const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
/** Re-root when the branch's reachable objects pass this, or once a quarter, whichever comes first. */
const PRUNE_AT_BYTES = 200 * 1024 * 1024;

const git = (args: string[], cwd?: string) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const fail = (message: string): never => {
	console.error(`ui-review-media: ${message}`);
	process.exit(1);
};
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** False when the branch does not exist yet, which only the first publish ever sees. */
function fetchBranch(): boolean {
	try {
		git(['fetch', 'origin', `+refs/heads/${BRANCH}:${REMOTE_REF}`]);
		return true;
	} catch {
		return false;
	}
}

/** What a clone pays for this branch: every object reachable from its tip, history included. */
const reachableBytes = () => Number(git(['rev-list', '--objects', '--disk-usage', REMOTE_REF]));

function publish(args: string[]) {
	const pr = args.shift();
	if (!pr || !/^\d+$/.test(pr)) fail('usage: publish <pr> [--dir <name>] [--slow] [row ...]');
	let dir = 'after';
	let gif = 'clip.gif';
	const rows: string[] = [];
	while (args.length) {
		const a = args.shift()!;
		if (a === '--dir') dir = args.shift() ?? fail('--dir needs a name');
		else if (a === '--slow') gif = 'clip-slow4x.gif';
		else rows.push(a);
	}
	const out = resolve(process.env.MOTION_OUT ?? 'tests/playwright/.artifacts/motion');
	if (!existsSync(out)) fail(`${out} does not exist: run bun run ui:review first, or set MOTION_OUT`);
	const picked = rows.length ? rows : readdirSync(out).filter((r) => existsSync(join(out, r, 'metrics.json')));
	if (!picked.length) fail(`no rows under ${out}`);
	for (const row of picked)
		for (const file of [gif, 'filmstrip.png']) {
			const path = join(out, row, file);
			if (!existsSync(path)) fail(`${path} is missing`);
			const size = statSync(path).size;
			if (size > MAX_FILE_BYTES)
				fail(`${row}/${file} is ${mb(size)}, over the ${mb(MAX_FILE_BYTES)} cap: lower the row's scale or crop it`);
		}

	const existed = fetchBranch();
	const work = join(mkdtempSync(join(tmpdir(), 'ui-review-media-')), 'tree');
	git(
		existed ? ['worktree', 'add', '--detach', work, REMOTE_REF] : ['worktree', 'add', '--orphan', '-b', BRANCH, work]
	);
	try {
		for (const row of picked) {
			const dest = join(work, `pr-${pr}`, dir, row);
			rmSync(dest, { recursive: true, force: true });
			mkdirSync(dest, { recursive: true });
			for (const file of [gif, 'filmstrip.png', 'metrics.json']) cpSync(join(out, row, file), join(dest, file));
		}
		git(['add', '--all'], work);
		git(['commit', '--quiet', '-m', `media: PR #${pr} (${dir})`], work);
		git(['push', 'origin', `HEAD:refs/heads/${BRANCH}`], work);
	} finally {
		git(['worktree', 'remove', '--force', work]);
		if (!existed) git(['branch', '-D', BRANCH]);
	}
	if (fetchBranch() && reachableBytes() > PRUNE_AT_BYTES)
		console.warn(`ui-review-media: the branch is past ${mb(PRUNE_AT_BYTES)}; run bun run ui:review:prune-media`);
	const base = `${REPO_URL}/blob/${BRANCH}/pr-${pr}/${dir}`;
	for (const row of picked)
		console.log(
			`**${row}**\n![${row}](${base}/${row}/${gif}?raw=true)\n[filmstrip](${base}/${row}/filmstrip.png?raw=true)\n`
		);
}

function prune(args: string[]) {
	const apply = args.includes('--apply');
	const keepArg = args[args.indexOf('--keep') + 1];
	const keep = new Set(args.includes('--keep') && keepArg ? keepArg.split(',').map((n) => `pr-${n.trim()}`) : []);
	if (!fetchBranch()) fail(`origin has no ${BRANCH} branch; nothing to prune`);
	const tip = git(['rev-parse', REMOTE_REF]);
	const entries = git(['ls-tree', '--full-tree', tip]).split('\n').filter(Boolean);
	const kept = entries.filter((e) => {
		const name = e.split('\t')[1];
		return name === 'README.md' || keep.has(name);
	});
	const dropped = entries.length - kept.length;
	console.log(
		`${BRANCH} at ${tip.slice(0, 8)}: ${mb(reachableBytes())} reachable, ${entries.length} top-level entries`
	);
	console.log(`keep: ${kept.map((e) => e.split('\t')[1]).join(', ') || '(nothing)'} · drop: ${dropped}`);
	console.log('Links in every dropped PR then 404. Pass --keep <pr,pr> for the PRs still open.');
	if (!apply) return console.log('dry run: pass --apply to re-root and force-push.');

	const tree = execFileSync('git', ['mktree'], { input: kept.join('\n') + '\n', encoding: 'utf8' }).trim();
	const root = git([
		'commit-tree',
		tree,
		'-m',
		`media: re-rooted from ${tip.slice(0, 8)}, kept ${[...keep].join(' ')}`
	]);
	// Pinned to the tip just read, so a publish that landed in between is refused rather than overwritten.
	git(['push', `--force-with-lease=refs/heads/${BRANCH}:${tip}`, 'origin', `${root}:refs/heads/${BRANCH}`]);
	fetchBranch();
	console.log(`re-rooted at ${root.slice(0, 8)}: ${mb(reachableBytes())} reachable on this clone's view of it`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'publish') publish(rest);
else if (command === 'prune') prune(rest);
else fail('usage: ui-review-media.ts publish <pr> [...] | prune [--keep <pr,pr>] [--apply]');
