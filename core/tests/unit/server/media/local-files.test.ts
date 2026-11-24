// Finding #2: the /media path-traversal guard. safeMediaPath must ONLY return paths inside
// MEDIA_DIR. These are the attack vectors the route depends on it rejecting.
import { test, expect, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { safeMediaPath } from '$lib/server/media/local-files';
import { mediaRoot } from '$lib/server/media/paths';

/** A real media tree with a secret beside it, so symlinks have something to point at (#1206). */
function withTree(run: (dirs: { media: string; secret: string }) => void) {
	const top = mkdtempSync(join(tmpdir(), 'encore-links-'));
	const media = join(top, 'media');
	mkdirSync(join(media, 'derived', 'stems'), { recursive: true });
	mkdirSync(join(media, 'meta'), { recursive: true });
	writeFileSync(join(media, 'meta', 'm1.json'), '{}');
	writeFileSync(join(media, 'song.mp3'), 'ok');
	const secret = join(top, 'worker-token');
	writeFileSync(secret, 'secret');
	process.env.MEDIA_DIR = media;
	try {
		run({ media, secret });
	} finally {
		rmSync(top, { recursive: true, force: true });
	}
}

test('a symlink inside media that points outside it is refused', () => {
	withTree(({ media, secret }) => {
		symlinkSync(secret, join(media, 'link-to-token'));
		symlinkSync(join(secret, '..'), join(media, 'derived', 'stems', 'up'));
		expect(safeMediaPath('link-to-token')).toBeNull();
		expect(safeMediaPath('derived/stems/up/worker-token')).toBeNull();
	});
});

test('a symlink into meta/ is refused, a dangling one too, and a link that stays inside media is served', () => {
	withTree(({ media }) => {
		symlinkSync(join(media, 'meta', 'm1.json'), join(media, 'sidecar.json'));
		symlinkSync(join(media, 'nowhere'), join(media, 'dangling'));
		symlinkSync(join(media, 'song.mp3'), join(media, 'alias.mp3'));
		expect(safeMediaPath('sidecar.json')).toBeNull();
		expect(safeMediaPath('dangling')).toBeNull();
		expect(safeMediaPath('alias.mp3')).toBe(join(media, 'alias.mp3'));
		expect(safeMediaPath('song.mp3')).toBe(join(media, 'song.mp3'));
		// A write target that does not exist yet still resolves.
		expect(safeMediaPath('derived/stems/new-instrumental.flac')).toBe(
			join(media, 'derived', 'stems', 'new-instrumental.flac')
		);
	});
});

test('a media root that is itself a symlink keeps working', () => {
	withTree(({ media }) => {
		const linked = `${media}-link`;
		symlinkSync(media, linked);
		process.env.MEDIA_DIR = linked;
		expect(safeMediaPath('song.mp3')).toBe(join(linked, 'song.mp3'));
		rmSync(linked);
	});
});

beforeEach(() => {
	process.env.MEDIA_DIR = '/srv/encore/media';
});

test('legitimate library file resolves inside MEDIA_DIR', () => {
	const p = safeMediaPath('library/sweet-caroline.mp4');
	expect(p).toBe(resolve('/srv/encore/media/library/sweet-caroline.mp4'));
	expect(p!.startsWith(mediaRoot() + sep)).toBe(true);
});

test('nested stems path is allowed', () => {
	expect(safeMediaPath('stems/abc123/instrumental.m4a')).toBe(
		resolve('/srv/encore/media/stems/abc123/instrumental.m4a')
	);
});

// ── traversal vectors must ALL return null ───────────────────────────────────────
test('rejects ../ traversal', () => {
	expect(safeMediaPath('../../etc/passwd')).toBeNull();
	expect(safeMediaPath('library/../../../etc/passwd')).toBeNull();
});

test('rejects absolute paths', () => {
	expect(safeMediaPath('/etc/passwd')).toBeNull();
	expect(safeMediaPath('\\windows\\system32')).toBeNull();
});

test('rejects URL-encoded traversal (%2e%2e%2f)', () => {
	expect(safeMediaPath('%2e%2e%2f%2e%2e%2fetc%2fpasswd')).toBeNull();
});

test('rejects NUL byte', () => {
	expect(safeMediaPath('library/song.mp4\0.txt')).toBeNull();
});

test('rejects a sibling dir that shares the MEDIA_DIR prefix (media-evil)', () => {
	// candidate /srv/encore/media-evil/x must NOT pass a naive startsWith(base) check
	expect(safeMediaPath('../media-evil/x.mp4')).toBeNull();
});

test('rejects the .thumbs cache dir (served only via /api/thumb)', () => {
	expect(safeMediaPath('.thumbs/deadbeef.jpg')).toBeNull();
});

test('rejects any dot-file or dot-dir segment, encoded or not', () => {
	for (const ref of ['.worker-token', '%2eworker-token', 'library/.hidden.mp3', 'derived/._x.flac', 'audio\\.env'])
		expect(safeMediaPath(ref), ref).toBeNull();
	expect(safeMediaPath('library/song.v2.mp3')).not.toBeNull();
});

test('never serves the worker token, wherever it was put (MEDIA_DIR=X, DATA_DIR=X/data, or set by hand)', () => {
	const saved = { DATA_DIR: process.env.DATA_DIR, FILE: process.env.ENCORE_WORKER_TOKEN_FILE };
	try {
		process.env.MEDIA_DIR = '/srv/encore';
		process.env.DATA_DIR = '/srv/encore/data';
		delete process.env.ENCORE_WORKER_TOKEN_FILE;
		expect(safeMediaPath('auth/worker-token')).toBeNull();
		expect(safeMediaPath('auth/worker-token.tmp-123')).toBeNull();
		expect(safeMediaPath('auth/anything')).toBeNull(); // the default auth/ dir is the token's alone
		expect(safeMediaPath('library/song.mp3')).toBe(resolve('/srv/encore/library/song.mp3'));
		process.env.ENCORE_WORKER_TOKEN_FILE = '/srv/encore/library/tok';
		expect(safeMediaPath('library/tok')).toBeNull();
		expect(safeMediaPath('library/tok.tmp-9')).toBeNull();
		expect(safeMediaPath('library/song.mp3')).not.toBeNull(); // a hand-set file's dir may hold media: only it is refused
	} finally {
		if (saved.DATA_DIR === undefined) delete process.env.DATA_DIR;
		else process.env.DATA_DIR = saved.DATA_DIR;
		if (saved.FILE === undefined) delete process.env.ENCORE_WORKER_TOKEN_FILE;
		else process.env.ENCORE_WORKER_TOKEN_FILE = saved.FILE;
	}
});

test('a linked MEDIA_DIR or DATA_DIR cannot alias the token back in: compared by real path both ways', () => {
	const root = mkdtempSync(join(tmpdir(), 'enc-lf-'));
	const saved = { DATA_DIR: process.env.DATA_DIR, FILE: process.env.ENCORE_WORKER_TOKEN_FILE };
	try {
		const disk = join(root, 'disk');
		const link = join(root, 'link');
		mkdirSync(join(disk, 'auth'), { recursive: true });
		writeFileSync(join(disk, 'auth', 'worker-token'), 'x'.repeat(43));
		writeFileSync(join(disk, 'song.mp3'), 'audio');
		symlinkSync(disk, link);
		delete process.env.ENCORE_WORKER_TOKEN_FILE;
		for (const [media, data] of [
			[link, join(disk, 'data')],
			[disk, join(link, 'data')]
		]) {
			process.env.MEDIA_DIR = media;
			process.env.DATA_DIR = data;
			expect(safeMediaPath('auth/worker-token'), `${media} ${data}`).toBeNull();
			expect(safeMediaPath('auth/worker-token.tmp-1'), `${media} ${data}`).toBeNull();
			expect(safeMediaPath('song.mp3'), `${media} ${data}`).not.toBeNull();
		}
	} finally {
		if (saved.DATA_DIR === undefined) delete process.env.DATA_DIR;
		else process.env.DATA_DIR = saved.DATA_DIR;
		if (saved.FILE !== undefined) process.env.ENCORE_WORKER_TOKEN_FILE = saved.FILE;
		rmSync(root, { recursive: true, force: true });
	}
});

test('empty / missing ref returns null', () => {
	expect(safeMediaPath('')).toBeNull();
});

// NON-VACUOUS proof: a real file path under the dir DOES pass — so the rejections above mean
// something (the guard isn't just "return null always").
test('guard is non-vacuous: a clean ref passes while traversal fails', () => {
	expect(safeMediaPath('ok.mp4')).not.toBeNull();
	expect(safeMediaPath('../ok.mp4')).toBeNull();
});
