// "Tonight" on the TV (proposal 29, PR 4): what the room saw, never a ranking, never an opted-out singer.
import { expect, test } from 'bun:test';
import { buildTonight, tonightPlays, type TonightInputs } from '$lib/server/nights/tonight';
import { NIGHT_GAP_MS } from '$lib/server/nights/repository';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const SINGERS: Record<string, { name: string; color: string }> = {
	maya: { name: 'Maya', color: '#ff7a7a' },
	theo: { name: 'Theo', color: '#b9a3ff' },
	ana: { name: 'Ana', color: '#6fd3c1' }
};

/** Each entry's song, by the entry it is sung on. */
const TITLES: Record<string, string> = {
	'm-e1': 'Sweet Caroline',
	'm-e2': "Don't Stop Believin'",
	'm-e3': 'Livin on a Prayer'
};

type T = TonightInputs['turns'][number];
const turn = (entryId: string, singerId: string, startedAt: number, extra: Partial<T> = {}): T => ({
	entryId,
	singerId,
	personId: null,
	mediaId: `m-${entryId}`,
	startedAt,
	end: 'finished',
	cheers: 0,
	...extra
});

function night(
	plays: [string, number][],
	turns: T[],
	optedOut: string[] = [],
	now = NOW
): ReturnType<typeof buildTonight> {
	return buildTonight({
		plays: plays.map(([entryId, at]) => ({ entryId, at })),
		turns,
		keeps: (singerId) => !optedOut.includes(singerId),
		singer: (id) => SINGERS[id] ?? null,
		title: (mediaId) => TITLES[mediaId] ?? 'A song',
		now
	});
}

test('a night everyone kept: totals, the first and last song, and who sang in the order they first sang', () => {
	const t = night(
		[
			['e1', NOW - 60 * MIN],
			['e2', NOW - 50 * MIN],
			['e3', NOW - 40 * MIN]
		],
		[
			turn('e1', 'theo', NOW - 60 * MIN, { cheers: 4 }),
			turn('e2', 'maya', NOW - 50 * MIN, { cheers: 9 }),
			turn('e3', 'theo', NOW - 40 * MIN, { cheers: 1 })
		]
	);
	expect(t).toEqual({
		songs: 3,
		singers: 2,
		cheers: 14,
		first: { title: 'Sweet Caroline', singer: SINGERS.theo! },
		last: { title: 'Livin on a Prayer', singer: SINGERS.theo! },
		everyone: [SINGERS.theo!, SINGERS.maya!]
	});
});

test('nothing in it ranks anyone: no per-singer or per-song counts reach the TV', () => {
	const t = night([['e1', NOW - MIN]], [turn('e1', 'maya', NOW - MIN, { cheers: 61 })])!;
	expect(JSON.stringify(t.everyone)).not.toContain('61');
	expect(JSON.stringify(t.first)).not.toContain('61');
	expect(Object.keys(t).sort()).toEqual(['cheers', 'everyone', 'first', 'last', 'singers', 'songs']);
	// One song has no "last song" slide.
	expect(t.last).toBeUndefined();
});

test('an opted-out singer is never named, coloured or counted, and the totals fall back to songs only', () => {
	// Ana's turn was never recorded (she said "Don't keep my nights"); her play is still a song the room heard.
	const t = night(
		[
			['e1', NOW - 30 * MIN],
			['e2', NOW - 20 * MIN],
			['e3', NOW - 10 * MIN]
		],
		[turn('e2', 'maya', NOW - 20 * MIN, { cheers: 3 })]
	)!;
	expect(t.songs).toBe(3);
	expect(t.singers).toBeUndefined();
	expect(t.cheers).toBeUndefined();
	// Ana opened and closed the night, so neither slide may name its singer, and Maya is not passed off as either.
	expect(t.first).toBeUndefined();
	expect(t.last).toBeUndefined();
	expect(t.everyone).toEqual([SINGERS.maya!]);
});

test('a singer who opted out after singing is hidden too, even though their rows still exist', () => {
	const t = night(
		[
			['e1', NOW - 20 * MIN],
			['e2', NOW - 10 * MIN]
		],
		[turn('e1', 'ana', NOW - 20 * MIN, { cheers: 5 }), turn('e2', 'theo', NOW - 10 * MIN)],
		['ana']
	)!;
	expect(JSON.stringify(t)).not.toContain('Ana');
	expect(JSON.stringify(t)).not.toContain(SINGERS.ana!.color);
	expect(t).toEqual({
		songs: 2,
		first: undefined,
		last: { title: "Don't Stop Believin'", singer: SINGERS.theo! },
		everyone: [SINGERS.theo!]
	});
});

test('a turn whose singer is gone (Delete me) is hidden like an opt-out', () => {
	const t = night([['e1', NOW - MIN]], [turn('e1', 'deleted-singer', NOW - MIN)])!;
	expect(t).toEqual({ songs: 1, first: undefined, last: undefined, everyone: [] });
});

test("a song that wouldn't play is not a song the room heard, and is never the first or last", () => {
	const t = night(
		[
			['e1', NOW - 20 * MIN],
			['e2', NOW - 10 * MIN]
		],
		[turn('e1', 'maya', NOW - 20 * MIN), turn('e2', 'theo', NOW - 10 * MIN, { end: 'failed' })]
	)!;
	expect(t.songs).toBe(1);
	expect(t.first?.singer).toEqual(SINGERS.maya!);
	expect(t.last).toBeUndefined();
	expect(t.everyone).toEqual([SINGERS.maya!]);
});

test("an opted-out singer's song that wouldn't play is not counted either, so it never becomes the last song", () => {
	// Maya finished; Ana, who no longer keeps her nights, had a song that wouldn't play.
	const t = night(
		[
			['e1', NOW - 20 * MIN],
			['e2', NOW - 10 * MIN]
		],
		[turn('e1', 'maya', NOW - 20 * MIN), turn('e2', 'ana', NOW - 10 * MIN, { end: 'failed' })],
		['ana']
	)!;
	expect(t.songs).toBe(1);
	expect(t.first).toEqual({ title: 'Sweet Caroline', singer: SINGERS.maya! });
	expect(t.last).toBeUndefined();
	expect(t.everyone).toEqual([SINGERS.maya!]);
	expect(JSON.stringify(t)).not.toContain('Ana');
});

test('tonight is the latest run of plays with no 6-hour gap, and there is none once that run is 6 hours old', () => {
	const plays = [
		{ entryId: 'old', at: NOW - NIGHT_GAP_MS - 2 * MIN },
		{ entryId: 'a', at: NOW - MIN },
		{ entryId: 'b', at: NOW }
	];
	expect(tonightPlays(plays, NOW).map((p) => p.entryId)).toEqual(['a', 'b']);
	expect(tonightPlays(plays, NOW + NIGHT_GAP_MS)).toEqual([]);
	expect(night([], [])).toBeNull();
});
