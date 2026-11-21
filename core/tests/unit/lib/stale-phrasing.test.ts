import { expect, test } from 'bun:test';
import { staleNotice } from '$lib/phrasing/stale-phrasing';

/*
 * What the phone says when the server drops one of its commands as stale: every command, on this phone's own turn or
 * someone else's, and in a room gone idle. A skip or restart inside the strip's settle window arrives while the strip
 * ALREADY shows the new song, so "That song already ended." read as wrong there (review of #982). Key and guide are
 * changed on a card that still showed the old song, where it is true, and so it is once nothing is playing (#985).
 */

const NB = '\u00a0';
const ENDED = `That song already${NB}ended.`;
const SKIP = `That song just ended. Tap again to skip this${NB}one.`;
const RESTART = `A new song just started. Tap again to restart${NB}it.`;
const CMDS = ['skip', 'restart', 'seek', 'key', 'guide'] as const;

const EXPECTED: Record<(typeof CMDS)[number], { other: string; own: string | null }> = {
	skip: { other: SKIP, own: null },
	restart: { other: RESTART, own: RESTART },
	seek: { other: ENDED, own: ENDED },
	key: { other: ENDED, own: ENDED },
	guide: { other: ENDED, own: ENDED }
};

for (const cmd of CMDS) {
	test(`stale ${cmd} on someone else's song`, () => {
		expect(staleNotice(cmd, { ownTurn: false, idle: false })).toBe(EXPECTED[cmd].other);
	});
	test(`stale ${cmd} on this phone's own new turn`, () => {
		expect(staleNotice(cmd, { ownTurn: true, idle: false })).toBe(EXPECTED[cmd].own);
	});
	test(`stale ${cmd} in a room gone idle says the song ended`, () => {
		expect(staleNotice(cmd, { ownTurn: false, idle: true })).toBe(ENDED);
	});
}

test('guest copy: straight apostrophes, and the last two words never split', () => {
	for (const cmd of CMDS) {
		for (const ownTurn of [false, true]) {
			for (const idle of [false, true]) {
				const s = staleNotice(cmd, { ownTurn, idle });
				if (s === null) continue;
				expect(s).not.toMatch(/[‘’“”]/);
				expect(s).toMatch(new RegExp(`\\S${NB}\\S+$`));
				expect(s.slice(0, s.lastIndexOf(NB))).not.toContain(NB);
			}
		}
	}
});
