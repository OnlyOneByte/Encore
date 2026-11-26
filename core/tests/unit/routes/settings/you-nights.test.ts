// Your night on the phone (proposal 29 PR 3): the story page and the You tab's list show only this phone's own nights,
// counted the way the story counts them, and a night that is not yours is a 404 however its id was learned.
import { test, expect, afterEach } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { SingerRepository, SESSION_COOKIE } from '$lib/server/singers/repository';
import { PeopleRepository } from '$lib/server/people/repository';
import { RoomRepository } from '$lib/server/rooms/repository';
import { NightLog } from '$lib/server/nights/repository';
import { nights, performances } from '$lib/server/db/schema';
import { streakLine } from '$lib/night-story';
import { yearIn, zoneOrServer, ZONE_COOKIE } from '$lib/server/nights/year';
import { GET as listNights } from '$routes/api/me/nights/+server';
import { load as storyLoad } from '$routes/(phone)/settings/you/nights/[id]/+page.server';
import { load as youLoad } from '$routes/(phone)/settings/you/+page.server';
import { EMPTY_SONG_PROFILE, type Media } from '$lib/contract';

const APP_KEY = Symbol.for('encore.app');
const T0 = 1_700_000_000_000;
const song = (id: string, title: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: id,
	title,
	durationSec: 200,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: `derived/stems/${id}-instrumental.flac`,
	songProfile: EMPTY_SONG_PROFILE
});

function installApp() {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const room = rooms.ensureActive(T0);
	const app = {
		db,
		rooms,
		activeRoomId: room.id,
		singers: new SingerRepository(db),
		people: new PeopleRepository(db),
		nights: new NightLog(db),
		mediaById: new Map([song('m1', 'Mayday'), song('m2', 'Fly Away'), song('m3', 'Gone')].map((m) => [m.id, m])),
		now: () => T0
	};
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = app;
	return app;
}
type App = ReturnType<typeof installApp>;
afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

function jar(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return { get: (n: string) => values.get(n), set: (n: string, v: string) => void values.set(n, v), delete: () => {} };
}
function event(path: string, cookies: ReturnType<typeof jar>, params: Record<string, string> = {}) {
	const url = new URL(path, 'http://192.168.1.20:3000');
	return { url, request: new Request(url), cookies, params, route: { id: path } } as never;
}
function guest(app: App, name: string) {
	const s = app.singers.create(name, '#a796ff', T0, app.activeRoomId);
	return { singer: s, cookies: jar({ [SESSION_COOKIE]: s.sessionToken }) };
}
let seq = 0;
function turn(
	app: App,
	singerId: string,
	nightId: string,
	mediaId: string,
	end: 'finished' | 'skipped' | 'failed',
	cheers: number
) {
	seq++;
	app.db
		.insert(performances)
		.values({
			id: `p${seq}`,
			roomId: app.activeRoomId,
			nightId,
			singerId,
			mediaId,
			entryId: `e${seq}`,
			startedAt: T0 + seq * 60_000,
			endedAt: T0 + seq * 60_000 + 30_000,
			end,
			keyShift: -2,
			cheers
		})
		.run();
}

async function status(fn: () => unknown): Promise<number | undefined> {
	try {
		await fn();
		return 200;
	} catch (e) {
		return (e as { status?: number }).status;
	}
}

test("the story is yours: slides from your turns, and another singer's night is a 404", async () => {
	const app = installApp();
	const theo = guest(app, 'Theo');
	const maya = guest(app, 'Maya');
	turn(app, theo.singer.id, 'n1', 'm1', 'finished', 37);
	turn(app, theo.singer.id, 'n1', 'm2', 'skipped', 21);
	turn(app, theo.singer.id, 'n1', 'm3', 'failed', 0);
	turn(app, maya.singer.id, 'n1', 'm2', 'finished', 50);
	turn(app, maya.singer.id, 'n2', 'm1', 'finished', 3);

	const data = (await storyLoad(event('/settings/you/nights/n1', theo.cookies, { id: 'n1' }))) as {
		name: string;
		slides: { kind: string }[];
	};
	expect(data.name).toBe('Theo');
	expect(data.slides).toEqual([
		{ kind: 'cover', songs: 2 },
		{ kind: 'loudest', cheers: 37, title: 'Mayday', ofSeveral: true },
		{
			kind: 'setlist',
			rows: [
				{ title: 'Mayday', cheers: 37, keyShift: -2 },
				{ title: 'Fly Away', cheers: 21, keyShift: -2 }
			],
			keyLine: 'You like it 2 keys down.'
		}
	] as never);
	// Maya's 50 cheers in the same night appear nowhere in Theo's story.
	expect(JSON.stringify(data)).not.toContain('50');
	// A night Theo sang nothing in, though Maya did, and a made-up id: both 404, never someone else's turns.
	expect(await status(() => storyLoad(event('/settings/you/nights/n2', theo.cookies, { id: 'n2' })))).toBe(404);
	expect(await status(() => storyLoad(event('/settings/you/nights/zz', theo.cookies, { id: 'zz' })))).toBe(404);
});

test('no cookie or a forged one goes to join, never to a story', async () => {
	const app = installApp();
	const theo = guest(app, 'Theo');
	turn(app, theo.singer.id, 'n1', 'm1', 'finished', 1);
	for (const cookies of [jar(), jar({ [SESSION_COOKIE]: 'forged' })])
		expect(await status(() => storyLoad(event('/settings/you/nights/n1', cookies, { id: 'n1' })))).toBe(303);
});

test('a night whose only turn would not play has no story and is not listed', async () => {
	const app = installApp();
	const theo = guest(app, 'Theo');
	turn(app, theo.singer.id, 'n1', 'm3', 'failed', 0);
	turn(app, theo.singer.id, 'n2', 'm1', 'finished', 0);
	turn(app, theo.singer.id, 'n2', 'm3', 'failed', 0);
	expect(await status(() => storyLoad(event('/settings/you/nights/n1', theo.cookies, { id: 'n1' })))).toBe(404);
	const you = (await youLoad(event('/settings/you', theo.cookies))) as {
		nights: { recording: boolean; list: { id: string; songs: number }[] };
	};
	expect(you.nights.recording).toBe(true);
	expect(you.nights.list.map((n) => [n.id, n.songs])).toEqual([['n2', 1]]);
	// GET /api/me/nights reads the same list, so the API and the page never disagree on a count.
	const api = app.nights.nightsFor({ singerId: theo.singer.id, personId: null });
	expect(api.map((n) => [n.id, n.songs])).toEqual([['n2', 1]]);
	// And the story's clock line ends with the last song sung, not the failed turn after it.
	const story = (await storyLoad(event('/settings/you/nights/n2', theo.cookies, { id: 'n2' }))) as { to: string };
	expect(story.to).toBe(
		new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
			.format(api[0]!.endedAt)
			.replace(' AM', ' am')
			.replace(' PM', ' pm')
	);
});

test('the You tab lists only your nights, newest first', async () => {
	const app = installApp();
	const theo = guest(app, 'Theo');
	const maya = guest(app, 'Maya');
	turn(app, theo.singer.id, 'n1', 'm1', 'finished', 0);
	turn(app, maya.singer.id, 'n2', 'm1', 'finished', 0);
	turn(app, theo.singer.id, 'n3', 'm2', 'finished', 0);
	turn(app, theo.singer.id, 'n3', 'm1', 'skipped', 0);
	const you = (await youLoad(event('/settings/you', theo.cookies))) as {
		nights: { list: { id: string; songs: number }[] };
	};
	expect(you.nights.list.map((n) => [n.id, n.songs])).toEqual([
		['n3', 2],
		['n1', 1]
	]);
});

function night(app: App, id: string, at: number) {
	app.db.insert(nights).values({ id, roomId: app.activeRoomId, startedAt: at, endedAt: at }).run();
}

test('the cover says the streak from two nights in a row, and a missed night ends it', async () => {
	const app = installApp();
	const theo = guest(app, 'Theo');
	const maya = guest(app, 'Maya');
	for (const [id, i] of [
		['n1', 1],
		['n2', 2],
		['n3', 3],
		['n4', 4]
	] as const)
		night(app, id, T0 + i);
	turn(app, theo.singer.id, 'n1', 'm1', 'finished', 0);
	turn(app, theo.singer.id, 'n3', 'm1', 'finished', 0);
	turn(app, theo.singer.id, 'n4', 'm2', 'finished', 0);
	// Maya sang every night: her streak is not Theo's.
	for (const id of ['n1', 'n2', 'n3', 'n4']) turn(app, maya.singer.id, id, 'm1', 'finished', 0);
	const streakOf = async (who: typeof theo, id: string) =>
		((await storyLoad(event(`/settings/you/nights/${id}`, who.cookies, { id }))) as { streak: string | null }).streak;
	expect(await streakOf(theo, 'n1')).toBeNull();
	expect(await streakOf(theo, 'n3')).toBeNull();
	expect(await streakOf(theo, 'n4')).toBe('2nd night in a row');
	expect(await streakOf(maya, 'n4')).toBe('4th night in a row');
});

test('streakLine: ordinals, and nothing for one night alone', () => {
	expect([0, 1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(streakLine)).toEqual([
		null,
		null,
		'2nd night in a row',
		'3rd night in a row',
		'4th night in a row',
		'11th night in a row',
		'12th night in a row',
		'13th night in a row',
		'21st night in a row',
		'22nd night in a row',
		'101st night in a row',
		'111th night in a row'
	]);
});

test("the You tab's year is yours alone, the same as GET /api/me/nights in the core's zone", async () => {
	const app = installApp();
	const theo = guest(app, 'Theo');
	const maya = guest(app, 'Maya');
	night(app, 'n1', T0);
	night(app, 'n2', T0 + 1);
	turn(app, theo.singer.id, 'n1', 'm1', 'finished', 0);
	turn(app, theo.singer.id, 'n2', 'm1', 'skipped', 0);
	turn(app, theo.singer.id, 'n2', 'm3', 'failed', 0);
	// Maya's five of Fly Away touch neither Theo's counts nor his most sung.
	for (let i = 0; i < 5; i++) turn(app, maya.singer.id, 'n2', 'm2', 'finished', 0);
	const you = (await youLoad(event('/settings/you', theo.cookies))) as {
		nights: { year: unknown; zone: string };
	};
	expect(you.nights.zone).toBe(zoneOrServer(null));
	expect(you.nights.year).toEqual({
		year: yearIn(T0, zoneOrServer(null)).year,
		nights: 2,
		songs: 2,
		mostSung: { mediaId: 'm1', title: 'Mayday', times: 2 }
	});
	const api = await (await listNights(event('/api/me/nights', theo.cookies) as never)).json();
	expect(api.year).toEqual(you.nights.year);
});

test("a phone's ?tz= is remembered, so the You tab's next load counts the year in its zone with nothing to swap (#1335)", async () => {
	const app = installApp();
	const theo = guest(app, 'Theo');
	night(app, 'n1', T0);
	turn(app, theo.singer.id, 'n1', 'm1', 'finished', 0);
	const far = 'Pacific/Kiritimati';
	const api = await (await listNights(event(`/api/me/nights?tz=${encodeURIComponent(far)}`, theo.cookies))).json();
	expect(theo.cookies.get(ZONE_COOKIE)).toBe(far);
	const you = (await youLoad(event('/settings/you', theo.cookies))) as { nights: { year: unknown; zone: string } };
	expect(you.nights.zone).toBe(far);
	expect(you.nights.year).toEqual(api.year);
	expect((api.year as { year: number }).year).toBe(yearIn(T0, far).year);

	// A zone Intl does not know is neither remembered nor counted in.
	const maya = guest(app, 'Maya');
	await listNights(event('/api/me/nights?tz=Mars%2FOlympus', maya.cookies));
	expect(maya.cookies.get(ZONE_COOKIE)).toBeUndefined();
	const hers = (await youLoad(event('/settings/you', maya.cookies))) as { nights: { zone: string } };
	expect(hers.nights.zone).toBe(zoneOrServer(null));
});
