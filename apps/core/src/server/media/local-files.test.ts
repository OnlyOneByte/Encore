// Finding #2: the /media path-traversal guard. safeMediaPath must ONLY return paths inside
// MEDIA_DIR. These are the attack vectors the route depends on it rejecting.
import { test, expect, beforeEach } from 'bun:test';
import { resolve, sep } from 'node:path';
import { safeMediaPath, mediaDir } from './local-files';

beforeEach(() => {
	process.env.MEDIA_DIR = '/srv/encore/media';
});

test('legitimate library file resolves inside MEDIA_DIR', () => {
	const p = safeMediaPath('library/sweet-caroline.mp4');
	expect(p).toBe(resolve('/srv/encore/media/library/sweet-caroline.mp4'));
	expect(p!.startsWith(mediaDir() + sep)).toBe(true);
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

test('empty / missing ref returns null', () => {
	expect(safeMediaPath('')).toBeNull();
});

// NON-VACUOUS proof: a real file path under the dir DOES pass — so the rejections above mean
// something (the guard isn't just "return null always").
test('guard is non-vacuous: a clean ref passes while traversal fails', () => {
	expect(safeMediaPath('ok.mp4')).not.toBeNull();
	expect(safeMediaPath('../ok.mp4')).toBeNull();
});
