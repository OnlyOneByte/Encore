// The join address a guest retypes off the wall. Three files derived this independently and none of
// them agreed; this pins the one behaviour they now share.
import { test, expect, describe } from 'bun:test';
import { joinAddressLabel } from '$lib/tv/join-address';

describe('joinAddressLabel', () => {
	test('drops the scheme, the room query and the bare trailing slash', () => {
		// The real shape from routes/tv/+page.server.ts: `${origin}/?room=${code}`.
		expect(joinAddressLabel('http://10.20.36.198:3500/?room=9DJECR')).toBe('10.20.36.198:3500');
	});

	/*
	 * THE SLASH IS THE DEFECT THIS FUNCTION EXISTS FOR. Two of the three call sites stripped the scheme
	 * and the query and left `host:port/` — printed at 44px as the most-transcribed string in the
	 * product, where a slash with nothing behind it reads as a path that got cut off.
	 */
	test('a lone trailing slash goes even with no query', () => {
		expect(joinAddressLabel('http://192.168.1.20:3000/')).toBe('192.168.1.20:3000');
	});

	/*
	 * …but a REAL path stays. A deployment behind a reverse proxy under a sub-path has to show it or the
	 * address a guest types does not resolve, so only an empty path segment is trimmed.
	 */
	test('a real path is preserved, and only its trailing slash is trimmed', () => {
		expect(joinAddressLabel('https://party.example.com/encore/')).toBe('party.example.com/encore');
		expect(joinAddressLabel('https://party.example.com/encore')).toBe('party.example.com/encore');
	});

	test('https and a hostname are handled the same way as http and an IP', () => {
		expect(joinAddressLabel('https://encore.local/?room=ABC123')).toBe('encore.local');
	});

	test('a fragment goes with the query', () => {
		expect(joinAddressLabel('http://host:3000/#anchor')).toBe('host:3000');
	});

	/* Idempotent, because the value it is handed may already have been through here — the badge used to
	   re-derive from an already-shortened string, which is how the two spellings diverged. */
	test('running it on its own output changes nothing', () => {
		const once = joinAddressLabel('http://10.20.36.198:3500/?room=9DJECR');
		expect(joinAddressLabel(once)).toBe(once);
	});
});
