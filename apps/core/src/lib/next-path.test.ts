import { describe, expect, it } from 'bun:test';
import { safeNextPath } from './next-path';

describe('safeNextPath', () => {
	it('passes an in-app path through, query and fragment included', () => {
		expect(safeNextPath('/settings')).toBe('/settings');
		expect(safeNextPath('/settings?tab=advanced#room')).toBe('/settings?tab=advanced#room');
	});

	it('falls back when nothing was requested', () => {
		expect(safeNextPath(null)).toBe('/');
		expect(safeNextPath(undefined)).toBe('/');
		expect(safeNextPath('')).toBe('/');
	});

	// The reason this function exists: a join link is the one URL handed to strangers at a party, so a
	// redirect target that can leave the origin would let someone else's page inherit its trust.
	it('refuses targets that escape the origin', () => {
		expect(safeNextPath('//evil.example')).toBe('/');
		expect(safeNextPath('/\\evil.example')).toBe('/');
		expect(safeNextPath('https://evil.example')).toBe('/');
		expect(safeNextPath('http://evil.example')).toBe('/');
		expect(safeNextPath('javascript:alert(1)')).toBe('/');
		expect(safeNextPath('settings')).toBe('/');
	});

	it('honours an explicit fallback', () => {
		expect(safeNextPath('https://evil.example', '/join')).toBe('/join');
	});
});
