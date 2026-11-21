// UI REVIEW MEDIA: put `bun run ui:review` output where a PR comment can show it, and keep that place small.
//
// `gh` cannot attach images to a PR, so the media lives on `ui-review-media`, an orphan branch that shares no
// history with main, and a PR comment links it (docs/UI-CHECKLIST.md#putting-the-gif-in-the-pr). Two commands:
//
//   bun run ui:review:publish-media -- <pr> [--dir <name>] [--slow | --realtime | --realtime=late] [row ...]
//       Copies each row's clip.gif and filmstrip.png (and metrics.json) to pr-<pr>/<dir>/<row>/, commits and
//       pushes without force, then prints the Markdown for the comment. Refuses a row whose media is over the cap.
//       `--realtime` publishes a timing row's realtime.gif and filmstrip-realtime.png instead (`=late`: the late run's).
//   bun run ui:review:prune-media -- --keep <pr,pr> [--apply]      (or --keep=<pr,pr>, or --keep-none)
//       Re-roots the branch as ONE new parentless commit holding only the kept PRs' folders, so every older
//       object stops being reachable. Dry-run unless --apply; the push is pinned to the commit it read.
//
// Both work in a THROWAWAY clone of origin under the OS temp dir, removed at the end, so the clone you run them
// from never fetches the branch: an opt-out clone (docs/UI-CHECKLIST.md) stays opted out.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { MAX_FILE_BYTES, overCap } from './world/motion-realtime';

const BRANCH = 'ui-review-media';
const REPO_URL = 'https://github.com/OnlyOneByte/Encore';
/** Re-root when the branch's reachable objects pass this, or once a quarter, whichever comes first. */
const PRUNE_AT_BYTES = 200 * 1024 * 1024;
/** A folder or row name: one path segment, never `.` or `..`, so it cannot climb out of the clone. */
const SEGMENT = /^(?!\.{1,2}$)[\w.-]+$/;

class Refused extends Error {}
const git = (args: string[], cwd?: string, input?: string) =>
	execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const segment = (what: string, value: string) => {
	if (!SEGMENT.test(value)) throw new Refused(`${what} "${value}" must be one plain name (letters, digits, . _ -)`);
	return value;
};

/** The remote tip, read without downloading anything. Null when the branch does not exist yet. */
function remoteTip(url: string): string | null {
	const line = git(['ls-remote', url, `refs/heads/${BRANCH}`]);
	return line ? line.split(/\s/)[0] : null;
}

/** Run `fn` in a scratch clone of just this branch (or a fresh orphan when there is none), then delete it. */
function inScratchClone<T>(url: string, opts: { bare: boolean; depth?: number }, fn: (dir: string) => T): T {
	const root = mkdtempSync(join(tmpdir(), 'ui-review-media-'));
	const dir = join(root, 'clone');
	try {
		if (remoteTip(url)) {
			const depth = opts.depth ? ['--depth', String(opts.depth)] : [];
			const bare = opts.bare ? ['--bare'] : [];
			git(['clone', '--quiet', '--no-tags', '--single-branch', '--branch', BRANCH, ...depth, ...bare, url, dir]);
		} else {
			git(['init', '--quiet', dir]);
			git(['checkout', '--quiet', '--orphan', BRANCH], dir);
			git(['remote', 'add', 'origin', url], dir);
		}
		return fn(dir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** One line, never a stack. It blames a race only when git says the ref moved under us (the lease, a
 *  non-fast-forward, a lock); any other refusal (auth, network, a hook) passes git's own reason through. */
function push(args: string[], cwd: string) {
	try {
		git(['push', '--quiet', ...args], cwd);
	} catch (e) {
		const lines = String((e as { stderr?: string }).stderr ?? e)
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
		const reason = lines.filter((l) => /rejected|error|fatal|denied|remote:/i.test(l)).join(' / ') || lines.join(' / ');
		const raced = /stale info|fetch first|non-fast-forward|cannot lock ref/i.test(reason);
		throw new Refused(
			`the push was refused: ${reason || 'git gave no reason'}` +
				(raced ? '. Someone published or pruned in the meantime; nothing was lost, run it again.' : '')
		);
	}
}

function publish(args: string[], url: string) {
	const pr = args.shift() ?? '';
	if (!/^\d+$/.test(pr))
		throw new Refused('usage: publish <pr> [--dir <name>] [--slow | --realtime | --realtime=late] [row ...]');
	let dir = 'after';
	let gif = 'clip.gif';
	let strip = 'filmstrip.png';
	const rows: string[] = [];
	const modes = new Set<string>();
	while (args.length) {
		const a = args.shift()!;
		if (a === '--dir') dir = segment('--dir', args.shift() ?? '');
		else if (a === '--slow') {
			gif = 'clip-slow4x.gif';
			modes.add('--slow');
		}
		// A timing row's real-time run INSTEAD of its seek run: still two files per row.
		else if (a === '--realtime' || a === '--realtime=late') {
			const run = a === '--realtime' ? 'realtime' : 'realtime-late';
			[gif, strip] = [`${run}.gif`, `filmstrip-${run}.png`];
			modes.add('--realtime');
		} else rows.push(segment('row', a));
	}
	// The slow GIF is the seek run's: with the real-time strip it would publish a pair from two different runs.
	if (modes.size > 1) throw new Refused('--slow and --realtime pick different runs; use one of them');
	const out = resolve(process.env.MOTION_OUT ?? 'tests/playwright/.artifacts/motion');
	if (!existsSync(out)) throw new Refused(`${out} does not exist: run bun run ui:review first, or set MOTION_OUT`);
	// With no rows named, every row that has this GIF: `--realtime` alone means the rows that opted in.
	const picked = rows.length
		? rows
		: readdirSync(out).filter(
				(r) => SEGMENT.test(r) && existsSync(join(out, r, 'metrics.json')) && existsSync(join(out, r, gif))
			);
	if (!picked.length) throw new Refused(`no rows under ${out}${gif === 'clip.gif' ? '' : ` with ${gif}`}`);
	for (const row of picked)
		for (const file of [gif, strip]) {
			const path = join(out, row, file);
			if (!existsSync(path)) throw new Refused(`${path} is missing`);
			const size = statSync(path).size;
			if (size > MAX_FILE_BYTES) throw new Refused(overCap(`${row}/${file}`, size));
		}

	const tipBytes = inScratchClone(url, { bare: false, depth: 1 }, (clone) => {
		for (const row of picked) {
			const dest = join(clone, `pr-${pr}`, dir, row);
			rmSync(dest, { recursive: true, force: true });
			mkdirSync(dest, { recursive: true });
			for (const file of [gif, strip, 'metrics.json']) cpSync(join(out, row, file), join(dest, file));
		}
		git(['add', '--all'], clone);
		git(['commit', '--quiet', '-m', `media: PR #${pr} (${dir})`], clone);
		push(['origin', `HEAD:refs/heads/${BRANCH}`], clone);
		return git(['ls-tree', '-r', '-l', '--full-tree', 'HEAD'], clone)
			.split('\n')
			.reduce((n, l) => n + (Number(l.split(/\s+/)[3]) || 0), 0);
	});
	// The tip alone: history holds more, so past the threshold here the branch certainly is too.
	if (tipBytes > PRUNE_AT_BYTES)
		console.warn(`ui-review-media: the branch tip holds ${mb(tipBytes)}; run bun run ui:review:prune-media`);
	const base = `${REPO_URL}/blob/${BRANCH}/pr-${pr}/${dir}`;
	for (const row of picked)
		console.log(
			`**${row}**\n![${row}](${base}/${row}/${gif}?raw=true)\n[filmstrip](${base}/${row}/${strip}?raw=true)\n`
		);
}

/** `--keep 973,980`, `--keep 973 980` and `--keep=973,980` all mean the same; anything not a PR number is refused. */
function parseKeep(args: string[]): { keep: string[]; keepNone: boolean; apply: boolean } {
	const keep: string[] = [];
	let keepNone = false;
	let apply = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--apply') apply = true;
		else if (a === '--keep-none') keepNone = true;
		else if (a === '--keep' || a.startsWith('--keep=')) {
			const values = a === '--keep' ? [] : [a.slice('--keep='.length)];
			if (a === '--keep') while (i + 1 < args.length && !args[i + 1].startsWith('--')) values.push(args[++i]);
			const items = values
				.flatMap((v) => v.split(','))
				.map((v) => v.trim())
				.filter(Boolean);
			if (!items.length) throw new Refused(`${a} needs PR numbers, e.g. --keep 973,980`);
			for (const n of items) if (!/^\d+$/.test(n)) throw new Refused(`--keep: "${n}" is not a PR number`);
			keep.push(...items);
		} else throw new Refused(`unknown argument "${a}"`);
	}
	if (keepNone && keep.length) throw new Refused('--keep-none and --keep together make no sense; pick one');
	return { keep: [...new Set(keep)], keepNone, apply };
}

function prune(args: string[], url: string) {
	const { keep, keepNone, apply } = parseKeep(args);
	if (!remoteTip(url)) throw new Refused(`origin has no ${BRANCH} branch; nothing to prune`);
	inScratchClone(url, { bare: true }, (clone) => {
		const ref = `refs/heads/${BRANCH}`;
		const tip = git(['rev-parse', ref], clone);
		const bytes = Number(git(['rev-list', '--objects', '--disk-usage', ref], clone));
		const entries = git(['ls-tree', '--full-tree', tip], clone).split('\n').filter(Boolean);
		const nameOf = (entry: string) => entry.split('\t')[1];
		const held = entries.map(nameOf).filter((n) => /^pr-\d+$/.test(n));
		const keepDirs = keep.map((n) => `pr-${n}`);
		console.log(`${BRANCH} at ${tip.slice(0, 8)}: ${mb(bytes)} reachable, holding ${held.join(', ') || 'no PRs'}`);
		console.log(`keep: ${keepDirs.join(', ') || (keepNone ? 'none (--keep-none)' : '(none given)')}`);
		const missing = keepDirs.filter((d) => !held.includes(d));
		if (missing.length) throw new Refused(`the branch holds no ${missing.join(', ')}: check the PR numbers`);
		if (!keep.length && !keepNone)
			throw new Refused("give the PRs still open with --keep <pr,pr>, or --keep-none to drop every PR's media");
		const kept = entries.filter((e) => nameOf(e) === 'README.md' || keepDirs.includes(nameOf(e)));
		const dropped = held.filter((d) => !keepDirs.includes(d));
		console.log(`drop: ${dropped.join(', ') || 'nothing'}. Every dropped PR's media links then 404.`);
		if (!apply) return console.log('dry run: add --apply to re-root and force-push.');

		const tree = git(['mktree'], clone, kept.map((e) => e + '\n').join(''));
		const label = keepDirs.join(' ') || 'nothing';
		const root = git(['commit-tree', tree, '-m', `media: re-rooted from ${tip.slice(0, 8)}, kept ${label}`], clone);
		// Pinned to the tip just read, so a publish that landed in between is refused rather than overwritten.
		push([`--force-with-lease=${ref}:${tip}`, 'origin', `${root}:${ref}`], clone);
		const after = Number(git(['rev-list', '--objects', '--disk-usage', root], clone));
		console.log(`re-rooted at ${root.slice(0, 8)}: ${mb(after)} reachable (was ${mb(bytes)})`);
	});
}

try {
	const [command, ...rest] = process.argv.slice(2);
	const url = git(['remote', 'get-url', 'origin']);
	if (command === 'publish') publish(rest, url);
	else if (command === 'prune') prune(rest, url);
	else throw new Refused('usage: ui-review-media.ts publish <pr> [...] | prune --keep <pr,pr> [--apply]');
} catch (e) {
	if (!(e instanceof Refused)) throw e;
	console.error(`ui-review-media: ${e.message}`);
	process.exit(1);
}
