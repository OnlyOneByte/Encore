// The role=worker upgrade gate's token: where it comes from, and its comparison. Constant-time: both sides are
// hashed first so timingSafeEqual always sees two equal-length buffers, and an absent token is just a mismatch.
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { audioDir, derivedDir, mediaRoot, metaDir } from '../media/paths';
import { realPath } from '../real-path';
import { cleanToken, codePoints } from '../secret-text';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Same floor as the host key: a short token is one a LAN device could guess, then fabricate job results. */
export const WORKER_TOKEN_MIN = 24;

/** Why `ENCORE_WORKER_TOKEN` cannot be used, or null when it is unset or long enough. */
export function workerTokenProblem(raw: string | null | undefined): string | null {
	const token = cleanToken(raw);
	// Invisible-only must refuse, not read as unset: unset here means worker auth is off.
	if (!token)
		return raw?.trim()
			? 'ENCORE_WORKER_TOKEN has no visible characters; set a random one (`openssl rand -base64 24`) or unset it.'
			: null;
	if (codePoints(token) >= WORKER_TOKEN_MIN) return null;
	return `ENCORE_WORKER_TOKEN is ${codePoints(token)} characters; it must be at least ${WORKER_TOKEN_MIN}. Make a random one with \`openssl rand -base64 24\` and set the same value on core and every worker.`;
}

type Env = Record<string, string | undefined>;

/** `auth/worker-token` beside DATA_DIR: the file compose, dev.sh and the README all point at. */
const defaultTokenFile = (env: Env) => resolve(env.DATA_DIR ?? './data', '..', 'auth', 'worker-token');

/** Where core keeps the token it makes: ENCORE_WORKER_TOKEN_FILE, else `auth/worker-token` beside DATA_DIR. */
export function workerTokenFile(env: Env = process.env): string {
	return resolve(env.ENCORE_WORKER_TOKEN_FILE?.trim() || defaultTokenFile(env));
}

const real = (p: string) => realPath(resolve(p)) ?? resolve(p);

/** Whether `dir` is the token's own directory (the default `auth/`), compared by real path, so core may set its mode. */
export function isTokenDir(dir: string, env: Env = process.env): boolean {
	return real(dir) === real(dirname(defaultTokenFile(env)));
}

/** The directories `/media/...` serves from, MEDIA_DIR and each storage class root, as real paths. */
export function servedRoots(): string[] {
	return [mediaRoot(), audioDir(), derivedDir(), metaDir()].map(real);
}

const within = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

/** The served root `path` falls in once every link is followed on both sides, or undefined. */
export const servedRootHolding = (path: string) => servedRoots().find((root) => within(real(path), root));

export type WorkerToken = {
	token: string | null;
	/** For the boot log. Names the file, never the token. */
	note: string | null;
	/** Set when core must not start. */
	refusal?: string;
};

/**
 * The token the gate checks. A set ENCORE_WORKER_TOKEN wins. Otherwise the file, made on first boot from 32 random
 * bytes: 0600 in a 0700 dir natively; 0640 in 0750 in a container, where the worker reads it through core's group.
 */
export function resolveWorkerToken(
	raw: string | null | undefined,
	file: string,
	inContainer: boolean,
	retried = false
): WorkerToken {
	const fromEnv = cleanToken(raw);
	if (fromEnv) return { token: fromEnv, note: null };
	const served = servedRootHolding(file);
	if (served) {
		const data = servedRootHolding(process.env.DATA_DIR ?? './data')
			? ' DATA_DIR inside MEDIA_DIR serves your database too: move DATA_DIR out of MEDIA_DIR.'
			: '';
		return {
			token: null,
			note: null,
			refusal: `The worker token file ${file} is inside ${served}, which /media serves to anyone. Set ENCORE_WORKER_TOKEN_FILE to a path outside MEDIA_DIR, or set ENCORE_WORKER_TOKEN.${data}`
		};
	}
	const mode = inContainer ? 0o640 : 0o600;
	const dirMode = inContainer ? 0o750 : 0o700;
	const notes: string[] = [];
	const dir = dirname(file);
	let created: string | undefined;
	try {
		created = mkdirSync(dir, { recursive: true, mode: dirMode });
	} catch (err) {
		return unusable(file, err);
	}
	// Only a directory that is the token's own: a hand-set file may sit in /tmp or $HOME, which are not core's.
	if (created !== undefined || isTokenDir(dir)) setMode(dir, dirMode, notes);
	else warnIfShared(dir, notes);
	let saved: string | null = null;
	try {
		saved = cleanToken(readFileSync(file, 'utf8')); // as the worker's clean_token reads it
	} catch (err) {
		if (errno(err) !== 'ENOENT') return unusable(file, err);
	}
	const remote = 'a worker on another machine needs its contents as ENCORE_WORKER_TOKEN';
	if (saved !== null && codePoints(saved) >= WORKER_TOKEN_MIN) {
		setMode(file, mode, notes);
		return { token: saved, note: [`worker token: ${file} (${remote})`, ...notes].join('; ') };
	}
	// Missing, or empty or short (a hand edit; a crash mid-write before writes were atomic): make one, whole or not at all.
	const token = randomBytes(32).toString('base64url');
	const tmp = `${file}.tmp-${process.pid}`;
	try {
		writeFileSync(tmp, `${token}\n`, { mode });
		chmodSync(tmp, mode); // a umask could strip the group bit the worker reads through
		if (saved === null) linkSync(tmp, file);
		else renameSync(tmp, file);
	} catch (err) {
		// EEXIST: another core linked its token first; read that one back.
		if (errno(err) === 'EEXIST' && !retried) return resolveWorkerToken(raw, file, inContainer, true);
		return unusable(file, err);
	} finally {
		try {
			unlinkSync(tmp);
		} catch {
			// renamed into place, or never written
		}
	}
	const made = saved === null ? 'made' : 'replaced an unusable token in';
	return { token, note: [`worker token: ${made} ${file} (${remote})`, ...notes].join('; ') };
}

/** Puts a loose (or, in a container, too tight for the worker) mode back, on a path core owns. */
function setMode(path: string, wanted: number, notes: string[]): void {
	try {
		const now = statSync(path).mode & 0o777;
		if (now === wanted) return;
		chmodSync(path, wanted);
		notes.push(`set ${path} from ${now.toString(8)} to ${wanted.toString(8)}`);
	} catch (err) {
		notes.push(`could not set ${path} to ${wanted.toString(8)} (${errno(err) ?? String(err)}); fix its mode by hand`);
	}
}

function warnIfShared(dir: string, notes: string[]): void {
	try {
		if (statSync(dir).mode & 0o022)
			notes.push(`${dir} is group- or world-writable, so another user could replace the token file in it`);
	} catch {
		// unreadable: the read below reports it
	}
}

const errno = (err: unknown) => (err as NodeJS.ErrnoException).code;

// Fails open, as before #1196: an older image whose auth volume came up root-owned must still boot.
const unusable = (file: string, err: unknown): WorkerToken => ({
	token: null,
	note: `could not read or make the worker token at ${file} (${errno(err) ?? String(err)})`
});

export function workerTokenMatches(presented: string | null, expected: string): boolean {
	return presented !== null && timingSafeEqual(digest(presented), digest(expected));
}
