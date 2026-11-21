import { expect, test } from 'bun:test';
import { staleNotice } from '$lib/phrasing/stale-phrasing';

/*
 * What the phone says when the server drops one of its commands as stale, per command. A skip or restart inside the
 * strip's settle window arrives while the strip ALREADY shows the new song, so "That song already ended." read as
 * wrong there (review of #982). Key and guide are changed on a card that still showed the old song, where it is true.
 */

test('a stale skip says the song was already skipped, and how to skip the new one', () => {
	expect(staleNotice('skip')).toBe('Already skipped. Tap again to skip this one too.');
});

test('a stale restart says a new song started, and how to restart it', () => {
	expect(staleNotice('restart')).toBe('New song just started. Tap again to restart it.');
});

test('key, guide and seek keep the plain truth', () => {
	for (const cmd of ['key', 'guide', 'seek'] as const) expect(staleNotice(cmd)).toBe('That song already ended.');
});

test('guest copy: straight apostrophes only, no curly quote anywhere', () => {
	for (const cmd of ['skip', 'restart', 'seek', 'key', 'guide'] as const) {
		expect(staleNotice(cmd)).not.toMatch(/[‘’“”]/);
	}
});
