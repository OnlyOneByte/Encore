// join -> singer:joined broadcast -> singer appears (validated via doJoin).
import { test, expect } from 'bun:test';
import { doJoin } from './join';
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
import { PlayTracker } from '../media/plays';
import type { EncoreApp } from '../app';

function appHarness(): { app: EncoreApp; published: ServerEvent[] } {
	const { db } = openDb(':memory:');
	runMigrations(db);
	const published: ServerEvent[] = [];
	const jobs = new JobRepository(db);
	const workers = new WorkerRegistry();
	const mediaById = new Map();
	const app: EncoreApp = {
		db,
		state: null as never,
		singers: new SingerRepository(db),
		presence: new PresenceTracker(),
		plays: new PlayTracker(() => {}),
		jobs,
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
