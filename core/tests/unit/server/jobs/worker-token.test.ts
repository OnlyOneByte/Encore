// The role=worker upgrade gate (server.ts) compares ENCORE_WORKER_TOKEN in constant time.
import { afterEach, beforeEach, describe, test, expect } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	symlinkSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	resolveWorkerToken,
	workerTokenFile,
	workerTokenMatches,
	workerTokenProblem
} from '$lib/server/jobs/worker-token';

test('a set token shorter than 24 characters is refused; unset or long enough is fine', () => {
	expect(workerTokenProblem('abc')).toContain('at least 24');
	expect(workerTokenProblem('abc')).toContain('openssl rand -base64 24');
	expect(workerTokenProblem('x'.repeat(23))).not.toBeNull();
	expect(workerTokenProblem(`  ${'x'.repeat(23)}  `)).not.toBeNull();
	expect(workerTokenProblem('x'.repeat(24))).toBeNull();
	expect(workerTokenProblem(undefined)).toBeNull();
	expect(workerTokenProblem('   ')).toBeNull();
});

test('server.ts exits before boot on a short worker token', () => {
	const server = readFileSync(join(CORE, 'server.ts'), 'utf8');
	expect(server).toContain('workerTokenProblem(process.env.ENCORE_WORKER_TOKEN)');
});

test('only the exact token matches, whatever the lengths', () => {
	expect(workerTokenMatches('s3 cr&t=/', 's3 cr&t=/')).toBe(true);
	expect(workerTokenMatches('s3 cr&t', 's3 cr&t=/')).toBe(false); // shorter: no length throw
	expect(workerTokenMatches('s3 cr&t=/x', 's3 cr&t=/')).toBe(false);
	expect(workerTokenMatches('', 's3 cr&t=/')).toBe(false);
	expect(workerTokenMatches(null, 's3 cr&t=/')).toBe(false);
});

const CORE = resolve(import.meta.dir, '../../../..');

/** Runs `fn` with these env vars set, then puts back what was there. */
function withEnv(vars: Record<string, string>, fn: () => void): void {
	const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
	Object.assign(process.env, vars);
	try {
		fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

describe('resolveWorkerToken', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'enc-wt-'));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test('unset: makes a 32-byte token in a 0600 file natively, and reuses it on the next boot', () => {
		const file = join(dir, 'auth', 'worker-token');
		const first = resolveWorkerToken(undefined, file, false);
		expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(readFileSync(file, 'utf8').trim()).toBe(first.token!);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(first.note).toContain(file);
		expect(first.note).not.toContain(first.token!);
		const second = resolveWorkerToken('  ', file, false);
		expect(second.token).toBe(first.token);
		expect(second.note).not.toContain(first.token!);
		// Read through cleanToken, as the worker's clean_token reads it: a hand edit's BOM is not part of it.
		const [bom, zeroWidth] = [String.fromCodePoint(0xfeff), String.fromCodePoint(0x200b)];
		writeFileSync(file, `${bom}${first.token}${zeroWidth}\n`);
		expect(resolveWorkerToken(undefined, file, false).token).toBe(first.token);
	});

	test("in a container the file is 0640, so the worker reads it through core's group", () => {
		const file = join(dir, 'worker-token');
		resolveWorkerToken('', file, true);
		expect(statSync(file).mode & 0o777).toBe(0o640);
	});

	test('a set ENCORE_WORKER_TOKEN wins and writes nothing', () => {
		const file = join(dir, 'worker-token');
		expect(resolveWorkerToken(`  ${'x'.repeat(24)} `, file, false).token).toBe('x'.repeat(24));
		expect(existsSync(file)).toBe(false);
	});

	test('an empty or short file is replaced whole, never left half-written; an unusable path fails open', () => {
		const file = join(dir, 'worker-token');
		for (const junk of ['', '   \n', 'short\n']) {
			writeFileSync(file, junk);
			const got = resolveWorkerToken(undefined, file, false);
			expect(got.refusal).toBeUndefined();
			expect(got.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(readFileSync(file, 'utf8').trim()).toBe(got.token!);
			expect(got.note).toContain('replaced an unusable token');
		}
		expect(readdirSync(dir)).toEqual(['worker-token']); // no temp file left behind
		const open = resolveWorkerToken(undefined, join(file, 'nested'), false); // its parent is a file
		expect(open.token).toBeNull();
		expect(open.refusal).toBeUndefined();
		expect(open.note).toContain('could not read or make');
	});

	test("the token's own auth/ dir and the file are set back to their modes; in a container, opened to 0640/0750", () =>
		withEnv({ DATA_DIR: join(dir, 'data'), MEDIA_DIR: join(dir, 'media') }, () => {
			const auth = join(dir, 'auth');
			const file = join(auth, 'worker-token');
			const first = resolveWorkerToken(undefined, file, false).token;
			chmodSync(file, 0o666);
			chmodSync(auth, 0o777);
			const again = resolveWorkerToken(undefined, file, false);
			expect(again.token).toBe(first);
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(statSync(auth).mode & 0o777).toBe(0o700);
			expect(again.note).toContain(`set ${file} from 666 to 600`);
			expect(again.note).not.toContain(first!);
			resolveWorkerToken(undefined, file, true);
			expect(statSync(file).mode & 0o777).toBe(0o640);
			expect(statSync(auth).mode & 0o777).toBe(0o750);
		}));

	test("a hand-set file in a shared dir (/tmp, $HOME) fixes only the file's mode, never the dir's", () =>
		withEnv({ DATA_DIR: join(dir, 'data'), MEDIA_DIR: join(dir, 'media') }, () => {
			const home = join(dir, 'home');
			const tmp = join(dir, 'tmp');
			mkdirSync(home, { mode: 0o755 });
			mkdirSync(tmp);
			chmodSync(home, 0o755);
			spawnSync('chmod', ['1777', tmp]); // Bun's chmodSync drops the sticky bit
			expect(statSync(tmp).mode & 0o7777).toBe(0o1777);
			const inHome = resolveWorkerToken(undefined, join(home, 'encore-token'), false);
			expect(inHome.token).not.toBeNull();
			expect(statSync(home).mode & 0o7777).toBe(0o755);
			expect(statSync(join(home, 'encore-token')).mode & 0o777).toBe(0o600);
			const inTmp = resolveWorkerToken(undefined, join(tmp, 'worker-token'), false);
			expect(statSync(tmp).mode & 0o7777).toBe(0o1777); // sticky bit kept
			expect(inTmp.note).toContain('group- or world-writable');
		}));

	test('a token file inside MEDIA_DIR (MEDIA_DIR=X, DATA_DIR=X/data) stops boot before anything is written', () =>
		withEnv({ MEDIA_DIR: dir, DATA_DIR: join(dir, 'data') }, () => {
			const file = workerTokenFile();
			expect(file).toBe(join(dir, 'auth', 'worker-token'));
			const got = resolveWorkerToken(undefined, file, false);
			expect(got.token).toBeNull();
			expect(got.refusal).toContain('ENCORE_WORKER_TOKEN_FILE to a path outside MEDIA_DIR');
			expect(got.refusal).toContain('move DATA_DIR out of MEDIA_DIR');
			expect(existsSync(join(dir, 'auth'))).toBe(false);
			// An explicit ENCORE_WORKER_TOKEN needs no file, so that layout still boots with one.
			expect(resolveWorkerToken('y'.repeat(24), file, false).refusal).toBeUndefined();
		}));

	test('the same layout through a symlink, either way round, is refused too (real paths)', () => {
		const disk = join(dir, 'disk');
		const link = join(dir, 'link');
		mkdirSync(disk);
		symlinkSync(disk, link);
		for (const env of [
			{ MEDIA_DIR: link, DATA_DIR: join(disk, 'data') },
			{ MEDIA_DIR: disk, DATA_DIR: join(link, 'data') }
		]) {
			withEnv(env, () => {
				const got = resolveWorkerToken(undefined, workerTokenFile(), false);
				expect(got.refusal, JSON.stringify(env)).toContain('which /media serves');
				expect(existsSync(join(disk, 'auth'))).toBe(false);
			});
		}
	});

	test('dev.sh hands core and the worker the same file, the one core would pick for its DATA_DIR', () => {
		const devSh = readFileSync(join(CORE, '../dev.sh'), 'utf8');
		expect(devSh).toContain('export DATA_DIR="$ROOT/data"');
		expect(devSh).toContain('export ENCORE_WORKER_TOKEN_FILE="${ENCORE_WORKER_TOKEN_FILE:-$ROOT/auth/worker-token}"');
		expect(workerTokenFile({ DATA_DIR: '/repo/data' })).toBe('/repo/auth/worker-token');
		// The worker is launched through `env`, which keeps an exported variable unless it is overridden there.
		expect(devSh.slice(devSh.indexOf('exec env \\'))).not.toContain('ENCORE_WORKER_TOKEN_FILE=');
	});

	test('the default path is auth/worker-token beside DATA_DIR; ENCORE_WORKER_TOKEN_FILE overrides it', () => {
		expect(workerTokenFile({ DATA_DIR: '/app/data' })).toBe('/app/auth/worker-token');
		expect(workerTokenFile({ DATA_DIR: '/app/data', ENCORE_WORKER_TOKEN_FILE: '/x/t' })).toBe('/x/t');
	});
});

test('the comparison itself is constant-time: timingSafeEqual over SHA-256 digests', () => {
	// A plain `===` passes every behavioural case above, so the timing property is pinned in the source.
	const helper = readFileSync(join(CORE, 'src/lib/server/jobs/worker-token.ts'), 'utf8');
	const body = helper.slice(helper.indexOf('export function workerTokenMatches'));
	expect(helper).toContain("createHash('sha256')");
	expect(body).toMatch(/timingSafeEqual\(\s*digest\(presented\),\s*digest\(expected\)\s*\)/);
	expect(body).not.toMatch(/presented\s*===?\s*expected/);
});

test('server.ts gates the upgrade through it, not a plain string compare', () => {
	const server = readFileSync(join(CORE, 'server.ts'), 'utf8');
	expect(server).toContain("!workerTokenMatches(url.searchParams.get('token'), WORKER_TOKEN)");
	expect(server).not.toMatch(/get\('token'\)\s*!==/);
});
