// join -> singer:joined broadcast -> singer appears (validated via doJoin).
import { test, expect } from 'bun:test';
import { doJoin, NameTakenError } from './join';
import { SingerRepository } from './repository';
import { openDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { SINGER_COLORS, SINGER_WHEEL, type ServerEvent } from '@encore/shared';
import { LocalLibrary } from '../media/local';
import { YouTubeResolver } from '../media/youtube';
import { createPopularityTracker } from '../media/popularity';
import { MediaRepository } from '../media/repository';
import { JobRepository } from '../jobs/repository';
import { SettingsRepository } from '../state/settings-repository';
import { JobReaper } from '../jobs/reaper';
import { WorkerRegistry } from '../jobs/registry';
import { WorkerHub } from '../jobs/worker-hub';
import { LocalMediaStore } from '../media/store';
import { PresenceTracker } from '../realtime/presence';
import { AuthoritativeState } from '../state/store';
import { PlayTracker } from '../media/plays';
import type { EncoreApp } from '../app';
import { AttemptLedger } from '../jobs/attempts';
import { PlayLog } from '../media/play-log';

function appHarness(): { app: EncoreApp; published: ServerEvent[] } {
	const { db } = openDb(':memory:');
	runMigrations(db);
	const published: ServerEvent[] = [];
	const attempts = new AttemptLedger(db);
	const jobs = new JobRepository(db, attempts);
	const workers = new WorkerRegistry();
	const mediaById = new Map();
	const app: EncoreApp = {
		db,
		// A real state, not null: doJoin now consults the queue, because a name stays claimed while its
		// owner still holds a turn.
		state: new AuthoritativeState(),
		singers: new SingerRepository(db),
		presence: new PresenceTracker(),
		plays: new PlayTracker(() => {}),
		jobs,
		attempts,
		playLog: new PlayLog(db),
		settings: new SettingsRepository(db),
		reaper: new JobReaper(jobs),
		workers,
		workerHub: new WorkerHub({ jobs, registry: workers, mediaById, toWorker: () => {}, broadcast: () => {}, now: () => 1_700_000_000_000 }),
		mediaById,
		media: new MediaRepository(db),
		localLibrary: new LocalLibrary(),
		youtube: new YouTubeResolver(async () => []),
		popularity: createPopularityTracker(),
		mediaStore: new LocalMediaStore(),
		mediaStoreConfig: { kind: 'local' },
		publish: (e) => published.push(e),
		toWorker: () => {},
		now: () => 1_700_000_000_000
	};
	return { app, published };
}

test('valid join creates a singer and broadcasts singer:joined', () => {
	const { app, published } = appHarness();
	const { singer } = doJoin(app, { displayName: 'Maya', color: '#ff5cae' });
	expect(singer.displayName).toBe('Maya');
	expect(singer.color).toBe('#ff5cae');
	expect(app.singers.bySessionToken(singer.sessionToken)?.id).toBe(singer.id);

	expect(published).toHaveLength(1);
	const ev = published[0] as Extract<ServerEvent, { type: 'singer:joined' }>;
	expect(ev.type).toBe('singer:joined');
	expect(ev.singer.id).toBe(singer.id);
});

test('invalid color falls back to the first palette color', () => {
	const { app } = appHarness();
	const { singer } = doJoin(app, { displayName: 'Sam', color: '#nonsense' });
	expect(singer.color).toBe(SINGER_COLORS[0]);
});

test('a wheel hue is KEPT, not rewritten to a preset', () => {
	// The behaviour change. This used to be an allowlist of the eight presets, so a guest who picked
	// any other hue joined as violet with nothing said — which made a colour wheel impossible.
	const { app } = appHarness();
	const picked = SINGER_WHEEL[7]!;
	const { singer } = doJoin(app, { displayName: 'Ada', color: picked });
	expect(singer.color).toBe(picked);
	expect(singer.color).not.toBe(SINGER_COLORS[0]);
});

test('a colour whose dot would vanish on the dark surfaces is refused', () => {
	const { app } = appHarness();
	const { singer } = doJoin(app, { displayName: 'Kai', color: '#000000' });
	expect(singer.color).toBe(SINGER_COLORS[0]);
});

test('shorthand hex is canonicalised on the way in', () => {
	// Everything downstream interpolates this straight into CSS, so one shape is worth enforcing here.
	const { app } = appHarness();
	const { singer } = doJoin(app, { displayName: 'Ren', color: '#0AF' });
	expect(singer.color).toBe('#00aaff');
});

test('blank display name is rejected', () => {
	const { app } = appHarness();
	expect(() => doJoin(app, { displayName: '   ', color: SINGER_COLORS[0] })).toThrow('display name required');
});

// ── display-name uniqueness ────────────────────────────────────────────────────
// First come, first served — but only against people still IN THE ROOM. The singers table is
// append-only, so an unqualified unique check would claim a name forever and next month's Dana would be
// rejected by a ghost row from tonight.

test('a name held by someone here is refused', () => {
	const { app } = appHarness();
	const first = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] });
	app.presence.connect(first.singer.id);
	expect(() => doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[1] })).toThrow(NameTakenError);
});

test('the check ignores case and surrounding whitespace', () => {
	const { app } = appHarness();
	app.presence.connect(doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer.id);
	expect(() => doJoin(app, { displayName: '  dana ', color: SINGER_COLORS[1] })).toThrow(NameTakenError);
	expect(() => doJoin(app, { displayName: 'DANA', color: SINGER_COLORS[1] })).toThrow(NameTakenError);
});

test('a name is still held while its owner is AWAY, so nobody takes it while she is in the kitchen', () => {
	const { app } = appHarness();
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	app.presence.connect(dana.id);
	app.presence.disconnect(dana.id, app.now());
	expect(() => doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[1] })).toThrow(NameTakenError);
});

test('a name returns to the pool once its owner has GONE', () => {
	const { app } = appHarness();
	app.settings.setRoom({ presenceGraceMinutes: 0 }); // expire on the first sweep after the drain
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	app.presence.connect(dana.id);
	app.presence.disconnect(dana.id, app.now());
	app.presence.evaluate({ now: app.now(), graceMs: 0, hasPendingSongs: () => false });

	// This is the case unqualified uniqueness would have broken forever: a different Dana, another night.
	const second = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[1] });
	expect(second.singer.displayName).toBe('Dana');
	expect(second.singer.id).not.toBe(dana.id);
});

test('a name nobody ever connected as does not block a join', () => {
	// A singer row with no socket this process (e.g. rehydrated after a restart) is `gone` by definition,
	// so their name must not be held hostage by the append-only table.
	const { app } = appHarness();
	doJoin(app, { displayName: 'Ghost', color: SINGER_COLORS[0] });
	expect(() => doJoin(app, { displayName: 'Ghost', color: SINGER_COLORS[1] })).not.toThrow();
});

test('distinct names are unaffected', () => {
	const { app } = appHarness();
	app.presence.connect(doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer.id);
	expect(() => doJoin(app, { displayName: 'Maya', color: SINGER_COLORS[1] })).not.toThrow();
});
