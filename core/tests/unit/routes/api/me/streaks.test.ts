// Streaks and "Your year" (proposal 29, PR 5): yours alone, compared only with yourself, and a night you did not keep
// never counts.
import { test, expect, afterEach } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { SingerRepository, SESSION_COOKIE } from '$lib/server/singers/repository';
import { GUEST_NIGHTS_RETENTION_MS, NIGHT_GAP_MS, NightLog, type TurnEnd } from '$lib/server/nights/repository';
import { recordTurn } from '$lib/server/nights/service';
import { yearIn, zoneOrServer } from '$lib/server/nights/year';
import { PlayLog } from '$lib/server/media/play-log';
import { nights } from '$lib/server/db/schema';
import type { QueueEntry } from '$lib/contract';
import { GET as listNights } from '$routes/api/me/nights/+server';
import { GET as oneNight } from '$routes/api/me/nights/[id]/+server';

const APP_KEY = Symbol.for('encore.app');
const ORIGIN = 'http://192.168.1.20:3000';
// Mid-year, so a week of nights stays in one calendar year in any time zone.
const T0 = new Date(2026, 5, 1, 20).getTime();
const DAY = 86_400_000;

function installApp() {
	const db = migratedDb();
	const app = {
		db,
		activeRoomId: 'room-1',
		singers: new SingerRepository(db),
		nights: new NightLog(db),
		playLog: new PlayLog(db),
		people: { exists: () => true },
		mediaById: new Map([
			['m1', { title: 'Fly Away' }],
			['m2', { title: 'Mayday' }]
		]),
		clock: T0 + 7 * DAY,
		now: () => app.clock
	};
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = app;
	return app;
}
type App = ReturnType<typeof installApp>;

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

let seq = 0;
/** One turn starting at `at`, written straight into the log. */
function singAt(
	app: App,
	singerId: string,
	at: number,
	opts: { mediaId?: string; end?: TurnEnd; roomId?: string; personId?: string } = {}
) {
	app.nights.record(
		{
			roomId: opts.roomId ?? 'room-1',
			singerId,
			personId: opts.personId ?? null,
			mediaId: opts.mediaId ?? 'm1',
			entryId: `e${++seq}`,
			startedAt: at,
			endedAt: at + 180_000,
			end: opts.end ?? 'finished',
			keyShift: 0,
			guideLevel: null
		},
		{ keyChanges: 0, cheers: 0 }
	);
}
/** One turn in the night that `day` falls in: a day apart is always a new night. */
function sing(app: App, singerId: string, day: number, mediaId = 'm1', end: TurnEnd = 'finished', roomId = 'room-1') {
	singAt(app, singerId, T0 + day * DAY + seq * 60_000, { mediaId, end, roomId });
}
/** One turn through the real path: its play is logged, then the turn ends and `recordTurn` decides whether to keep it. */
function singForReal(app: App, singerId: string, day: number) {
	const entry = { id: `r${++seq}`, mediaId: 'm1', singerId } as QueueEntry;
	app.clock = T0 + day * DAY;
	app.playLog.record(entry.mediaId, entry.id, app.clock);
	app.clock += 180_000;
	recordTurn(app as never, entry, 'finished', { keyShift: 0, guideLevel: null }, (write) => write());
}

function call(path: string, token: string, params: Record<string, string> = {}) {
	const url = new URL(path, ORIGIN);
	const values = new Map([[SESSION_COOKIE, token]]);
	return {
		request: new Request(url, { headers: { host: '192.168.1.20:3000' } }),
		url,
		params,
		cookies: { get: (n: string) => values.get(n), set: () => {}, delete: () => {} }
	} as never;
}

/** The room's nights, oldest first. */
const nightIds = (app: App) =>
	app.db
		.select({ id: nights.id })
		.from(nights)
		.orderBy(nights.startedAt)
		.all()
		.map((n) => n.id);

test("a streak counts this room's nights in a row you sang in, and a night you missed ends it", () => {
	const app = installApp();
	const theo = app.singers.create('Theo', '#a796ff', T0, 'room-1');
	const maya = app.singers.create('Maya', '#ff7a7a', T0, 'room-1');
	expect(DAY).toBeGreaterThan(NIGHT_GAP_MS);
	sing(app, theo.id, 0);
	sing(app, maya.id, 1); // Theo missed night 2
	sing(app, theo.id, 2);
	sing(app, maya.id, 2);
	sing(app, theo.id, 3);
	sing(app, theo.id, 4);
	const [, n2, n3, n4, n5] = nightIds(app);
	const theoOwner = { singerId: theo.id, personId: null };
	expect(app.nights.streakAt(theoOwner, n5!)).toBe(3);
	expect(app.nights.streakAt(theoOwner, n3!)).toBe(1);
	// Maya's streak is hers: she sang night 2 and 3, not 4 or 5.
	expect(app.nights.streakAt({ singerId: maya.id, personId: null }, n3!)).toBe(2);
	expect(app.nights.streakAt({ singerId: maya.id, personId: null }, n5!)).toBe(0);
	expect(app.nights.streakAt(theoOwner, n2!)).toBe(0);
	void n4;
});

test('a night you opted out of never counts, and ends the streak (through the real opt-out path)', () => {
	const app = installApp();
	const theo = app.singers.create('Theo', '#a796ff', T0, 'room-1');
	const maya = app.singers.create('Maya', '#ff7a7a', T0, 'room-1');
	singForReal(app, theo.id, 0);
	// Night 2: Theo said "Don't keep my nights" and sang anyway; Maya sang too.
	app.nights.setRecording([theo.id], false, app.now());
	singForReal(app, theo.id, 1);
	singForReal(app, maya.id, 1);
	app.nights.setRecording([theo.id], true, app.now());
	// Night 3: Theo keeps his nights again.
	singForReal(app, theo.id, 2);
	const ids = nightIds(app);
	expect(ids).toHaveLength(3);
	const owner = { singerId: theo.id, personId: null };
	expect(app.nights.night(owner, ids[1]!), 'his opted-out turn was kept').toBeNull();
	expect(app.nights.streakAt(owner, ids[2]!)).toBe(1);
	expect(app.nights.streakAt({ singerId: maya.id, personId: null }, ids[1]!)).toBe(1);
});

test('a night you deleted or only failed in never counts, and another room is not this streak', () => {
	const app = installApp();
	const theo = app.singers.create('Theo', '#a796ff', T0, 'room-1');
	const maya = app.singers.create('Maya', '#ff7a7a', T0, 'room-1');
	sing(app, theo.id, 0);
	// Night 2: Theo's only song wouldn't play.
	sing(app, theo.id, 1, 'm1', 'failed');
	sing(app, maya.id, 1);
	sing(app, theo.id, 2);
	const ids = nightIds(app);
	const owner = { singerId: theo.id, personId: null };
	expect(app.nights.streakAt(owner, ids[2]!)).toBe(1);
	// Another room's nights are not this room's streak.
	sing(app, theo.id, 3, 'm1', 'finished', 'room-2');
	expect(app.nights.streakAt(owner, nightIds(app)[3]!)).toBe(1);
	// Delete my history: no night of his counts any more.
	app.nights.deleteFor(owner);
	expect(app.nights.streakAt(owner, ids[2]!)).toBe(0);
});

test("the guest sweep keeps the night rows, so a night a guest alone sang never joins a kept person's streak", () => {
	const app = installApp();
	const theo = app.singers.create('Theo', '#a796ff', T0, 'room-1');
	const ana = app.singers.create('Ana', '#6fd3c1', T0, 'room-1');
	// Theo is kept, so his rows outlive the guest sweep; night 2 was Ana's alone.
	singAt(app, theo.id, T0, { personId: 'p1' });
	singAt(app, ana.id, T0 + DAY);
	singAt(app, theo.id, T0 + 2 * DAY, { personId: 'p1' });
	const theoOwner = { singerId: theo.id, personId: 'p1' };
	const [, , n3] = nightIds(app);
	expect(app.nights.streakAt(theoOwner, n3!)).toBe(1);
	const gone = app.nights.sweepGuests(T0 + 2 * DAY + GUEST_NIGHTS_RETENTION_MS + DAY);
	expect(gone).toBe(1);
	expect(nightIds(app)).toHaveLength(3);
	expect(app.nights.streakAt(theoOwner, n3!)).toBe(1);
});

test('your year counts your nights and songs that played, and your most-sung song only against your own', () => {
	const app = installApp();
	const theo = app.singers.create('Theo', '#a796ff', T0, 'room-1');
	const maya = app.singers.create('Maya', '#ff7a7a', T0, 'room-1');
	sing(app, theo.id, 0, 'm1');
	sing(app, theo.id, 1, 'm2');
	sing(app, theo.id, 2, 'm2');
	sing(app, theo.id, 2, 'm1', 'failed');
	// Maya sang m1 five times; that is not Theo's year.
	for (let d = 0; d < 5; d++) sing(app, maya.id, d, 'm1');
	const from = new Date(2026, 0, 1).getTime();
	const to = new Date(2027, 0, 1).getTime();
	expect(app.nights.yearFor({ singerId: theo.id, personId: null }, from, to)).toEqual({
		nights: 3,
		songs: 3,
		mostSung: { mediaId: 'm2', times: 2 }
	});
	// No song twice: no "most sung" at all.
	const ana = app.singers.create('Ana', '#6fd3c1', T0, 'room-1');
	sing(app, ana.id, 0, 'm1');
	expect(app.nights.yearFor({ singerId: ana.id, personId: null }, from, to).mostSung).toBeNull();
	// Last year's turns are not this year's.
	expect(app.nights.yearFor({ singerId: theo.id, personId: null }, to, to + 365 * DAY).songs).toBe(0);
});

test("a kept person's streak spans their phones", () => {
	const app = installApp();
	const phoneA = app.singers.create('Theo', '#a796ff', T0, 'room-1');
	const phoneB = app.singers.create('Theo', '#a796ff', T0, 'room-1');
	sing(app, phoneA.id, 0);
	sing(app, phoneB.id, 1);
	app.nights.linkPerson(phoneA.id, 'p1', T0);
	app.nights.linkPerson(phoneB.id, 'p1', T0);
	const ids = nightIds(app);
	expect(app.nights.streakAt({ singerId: phoneB.id, personId: 'p1' }, ids[1]!)).toBe(2);
	// Without the device proof, phone B is only itself.
	expect(app.nights.streakAt({ singerId: phoneB.id, personId: null }, ids[1]!)).toBe(1);
});

test('the routes serve your own streak and year only', async () => {
	const app = installApp();
	const theo = app.singers.create('Theo', '#a796ff', T0, 'room-1');
	const maya = app.singers.create('Maya', '#ff7a7a', T0, 'room-1');
	sing(app, theo.id, 5, 'm2');
	sing(app, theo.id, 6, 'm2');
	sing(app, maya.id, 6, 'm1');
	const [, last] = nightIds(app);

	const mine = await (await oneNight(call(`/api/me/nights/${last}`, theo.sessionToken, { id: last! }))).json();
	expect(mine.streak).toBe(2);
	const hers = await (await oneNight(call(`/api/me/nights/${last}`, maya.sessionToken, { id: last! }))).json();
	expect(hers.streak).toBe(1);
	expect(JSON.stringify(hers)).not.toContain('Mayday');

	const list = await (await listNights(call('/api/me/nights', theo.sessionToken))).json();
	expect(list.year).toEqual({
		year: 2026,
		nights: 2,
		songs: 2,
		mostSung: { mediaId: 'm2', title: 'Mayday', times: 2 }
	});
	const herList = await (await listNights(call('/api/me/nights', maya.sessionToken))).json();
	expect(herList.year).toEqual({ year: 2026, nights: 1, songs: 1, mostSung: null });
	expect((await listNights(call('/api/me/nights', 'forged'))).status).toBe(401);
});

test("this year's bounds are the phone's zone's, and an unknown zone falls back to the core's", () => {
	const at = Date.parse('2027-01-01T03:00:00Z');
	// New York is still in 2026 at 22:00 on Dec 31; Tokyo is in 2027 since 15:00 UTC on Dec 31.
	expect(yearIn(at, 'America/New_York')).toEqual({
		year: 2026,
		from: Date.parse('2026-01-01T05:00:00Z'),
		to: Date.parse('2027-01-01T05:00:00Z')
	});
	expect(yearIn(at, 'Asia/Tokyo')).toEqual({
		year: 2027,
		from: Date.parse('2026-12-31T15:00:00Z'),
		to: Date.parse('2027-12-31T15:00:00Z')
	});
	const server = new Intl.DateTimeFormat().resolvedOptions().timeZone;
	expect(zoneOrServer('Not/AZone')).toBe(server);
	expect(zoneOrServer('')).toBe(server);
	expect(zoneOrServer(null)).toBe(server);
	expect(zoneOrServer('x'.repeat(200))).toBe(server);
	expect(zoneOrServer('Asia/Tokyo')).toBe('Asia/Tokyo');
});

test('GET /api/me/nights?tz= puts a night near midnight on Dec 31 in the year of the phone that asks', async () => {
	const app = installApp();
	const theo = app.singers.create('Theo', '#a796ff', T0, 'room-1');
	// 23:30 UTC on Dec 31: 18:30 in New York (2026) and 08:30 on Jan 1 in Tokyo (2027).
	singAt(app, theo.id, Date.parse('2026-12-31T23:30:00Z'));
	app.clock = Date.parse('2027-01-01T03:00:00Z');
	const year = async (tz?: string) =>
		(
			await (
				await listNights(call(`/api/me/nights${tz ? `?tz=${encodeURIComponent(tz)}` : ''}`, theo.sessionToken))
			).json()
		).year;
	expect(await year('America/New_York')).toEqual({ year: 2026, nights: 1, songs: 1, mostSung: null });
	expect(await year('Asia/Tokyo')).toEqual({ year: 2027, nights: 1, songs: 1, mostSung: null });
	// No zone, or one Intl refuses, is the core's own: the same answer either way.
	expect(await year('Not/AZone')).toEqual(await year());
});

test('a night that crosses midnight on Dec 31 counts, with every song of it, in the year it started', () => {
	const app = installApp();
	const theo = app.singers.create('Theo', '#a796ff', T0, 'room-1');
	singAt(app, theo.id, Date.parse('2026-12-31T23:10:00Z'));
	singAt(app, theo.id, Date.parse('2027-01-01T00:20:00Z'), { mediaId: 'm2' });
	expect(nightIds(app)).toHaveLength(1);
	const owner = { singerId: theo.id, personId: null };
	const y2026 = yearIn(Date.parse('2026-06-01T00:00:00Z'), 'UTC');
	const y2027 = yearIn(Date.parse('2027-06-01T00:00:00Z'), 'UTC');
	expect(app.nights.yearFor(owner, y2026.from, y2026.to)).toEqual({ nights: 1, songs: 2, mostSung: null });
	expect(app.nights.yearFor(owner, y2027.from, y2027.to)).toEqual({ nights: 0, songs: 0, mostSung: null });
});
