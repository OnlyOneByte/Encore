// M6-C1: thumb cache-key logic + extension/content-type mapping + safety.
import { test, expect } from 'bun:test';
import { thumbKey, thumbPath, contentTypeFor, isAllowedThumbUrl, serveThumb } from './thumbs';

test('thumbKey is stable + filesystem-safe (no slashes) for a URL', () => {
	const k = thumbKey('https://i.ytimg.com/vi/abc123/hqdefault.jpg');
	expect(k).toMatch(/^[0-9a-f]+\.jpg$/);
	expect(k).not.toContain('/');
});

test('thumbKey preserves recognized extensions', () => {
	expect(thumbKey('http://x/a.png')).toMatch(/\.png$/);
	expect(thumbKey('http://x/a.webp?q=1')).toMatch(/\.webp$/);
	expect(thumbKey('http://x/no-ext')).toMatch(/\.jpg$/); // default
});

test('same url -> same key; different url -> different key', () => {
	expect(thumbKey('http://x/a.jpg')).toBe(thumbKey('http://x/a.jpg'));
	expect(thumbKey('http://x/a.jpg')).not.toBe(thumbKey('http://x/b.jpg'));
});

test('thumbPath lands under the media .thumbs dir', () => {
	expect(thumbPath('http://x/a.jpg')).toContain('.thumbs');
});

test('contentTypeFor maps extensions', () => {
	expect(contentTypeFor('h.jpg')).toBe('image/jpeg');
	expect(contentTypeFor('h.png')).toBe('image/png');
	expect(contentTypeFor('h.webp')).toBe('image/webp');
	expect(contentTypeFor('h.unknown')).toBe('image/jpeg');
});

// ── SSRF guard (Finding #1): only proxy allowlisted YouTube thumbnail hosts ──────
test('allows known YouTube thumbnail hosts over https', () => {
	expect(isAllowedThumbUrl('https://i.ytimg.com/vi/abc/hqdefault.jpg')).toBe(true);
	expect(isAllowedThumbUrl('https://yt3.ggpht.com/x')).toBe(true);
	expect(isAllowedThumbUrl('https://img.youtube.com/vi/abc/0.jpg')).toBe(true);
});

test('BLOCKS SSRF vectors: metadata IP, internal hosts, non-allowlisted domains', () => {
	expect(isAllowedThumbUrl('http://169.254.169.254/latest/meta-data/')).toBe(false); // cloud metadata
	expect(isAllowedThumbUrl('http://localhost:3000/health')).toBe(false);
	expect(isAllowedThumbUrl('https://localhost/x')).toBe(false);
	expect(isAllowedThumbUrl('https://evil.example.com/x.jpg')).toBe(false);
	expect(isAllowedThumbUrl('http://10.0.0.5/internal')).toBe(false);
});

test('BLOCKS http even on an allowlisted host (no plaintext SSRF)', () => {
	expect(isAllowedThumbUrl('http://i.ytimg.com/vi/abc/hqdefault.jpg')).toBe(false);
});

test('BLOCKS junk + non-http schemes', () => {
	expect(isAllowedThumbUrl('file:///etc/passwd')).toBe(false);
	expect(isAllowedThumbUrl('not a url')).toBe(false);
	expect(isAllowedThumbUrl('')).toBe(false);
});

test('serveThumb returns 400 for a forbidden host WITHOUT fetching', async () => {
	const res = await serveThumb('http://169.254.169.254/latest/meta-data/');
	expect(res.status).toBe(400);
});

test('thumbKey is collision-resistant sha256 hex (32 hex chars + ext)', () => {
	expect(thumbKey('https://i.ytimg.com/vi/abc/hqdefault.jpg')).toMatch(/^[0-9a-f]{32}\.jpg$/);
});
