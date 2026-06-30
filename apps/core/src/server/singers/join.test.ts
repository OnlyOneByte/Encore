// M2-C2 done-when: join -> singer:joined broadcast -> singer appears (validated via doJoin).
import { test, expect } from 'bun:test';
import { doJoin } from './join';
import { SingerRepository } from './repository';
import { openDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { SINGER_COLORS, type ServerEvent } from '@encore/shared';
import { LocalLibrary } from '../media/local';
import { YouTubeResolver } from '../media/youtube';
import { createPopularityTracker } from '../media/popularity';
import { JobRepository } from '../jobs/repository';
import { JobReaper } from '../jobs/reaper';
import { WorkerRegistry } from '../jobs/registry';
import { WorkerHub } from '../jobs/worker-hub';
import type { EncoreApp } from '../app';

function appHarness(): { app: EncoreApp; published: ServerEvent[] } {
	const { db } = openDb(':memory:');
	runMigrations(db, './drizzle');
	const published: ServerEvent[] = [];
	const jobs = new JobRepository(db);
	const workers = new WorkerRegistry();
	const mediaById = new Map();
	const app: EncoreApp = {
		db,
		state: null as never,
		singers: new SingerRepository(db),
		jobs,
		reaper: new JobReaper(jobs),
		workers,
		workerHub: new WorkerHub({ jobs, registry: workers, mediaById, toWorker: () => {}, broadcast: () => {}, now: () => 1_700_000_000_000 }),
		mediaById,
		localLibrary: new LocalLibrary(),
		youtube: new YouTubeResolver(async () => []),
		popularity: createPopularityTracker(),
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

test('blank display name is rejected', () => {
	const { app } = appHarness();
	expect(() => doJoin(app, { displayName: '   ', color: SINGER_COLORS[0] })).toThrow('display name required');
});
