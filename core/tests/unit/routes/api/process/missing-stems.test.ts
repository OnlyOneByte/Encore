// guard: #1153, route half. A song whose status says ready but whose stems are gone from the store gets a
// real process, not `alreadyReady`: the route must hand the store's answer to processState and requestProcess.
import { test, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POST } from '$routes/api/process/+server';
import { AuthoritativeState } from '$lib/server/state/store';
import { JobRepository } from '$lib/server/jobs/repository';
import { migratedDb } from '$lib/server/db/test-db';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { LocalMediaStore } from '$lib/server/media/store';
import type { Media } from '$lib/contract';

const APP_KEY = Symbol.for('encore.app');
let root: string;
let saved: string | undefined;

beforeEach(() => {
	saved = process.env.MEDIA_DIR;
	root = mkdtempSync(join(tmpdir(), 'encore-route-'));
	process.env.MEDIA_DIR = root;
	mkdirSync(join(root, 'derived', 'stems'), { recursive: true });
});
afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
	if (saved === undefined) delete process.env.MEDIA_DIR;
	else process.env.MEDIA_DIR = saved;
	rmSync(root, { recursive: true, force: true });
});

function installApp(): Media {
	const db = migratedDb();
	const m: Media = {
		id: 'm1',
		source: 'local',
		sourceRef: 'library/m1.flac',
		title: 'm1',
		durationSec: 200,
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac'
	};
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		now: () => 1_700_000_000_000,
		mediaById: new Map([['m1', m]]),
		state: new AuthoritativeState(),
		jobs: new JobRepository(db),
		singers: { bySessionToken: () => ({ id: 's1', displayName: 'Ada' }) },
		settings: new SettingsRepository(db),
		media: { upsert: () => {} },
		mediaStore: new LocalMediaStore(),
		publish: () => {},
		workerHub: { dispatch: () => {}, isUnservable: () => false }
	};
	return m;
}

const call = () =>
	POST({
		request: new Request('http://x/api/process', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mediaId: 'm1' })
		}),
		cookies: { get: () => 'tok' }
	} as never);

test('stems missing from the store: the pick starts a process', async () => {
	const m = installApp();
	const body = (await (await call()).json()) as { alreadyReady?: boolean; job?: { status: string } };
	expect(body.alreadyReady).toBeFalsy();
	expect(body.job?.status).toBe('queued');
	expect(m.stemStatus).toBe('queued');
});

test('CONTROL: stems in the store are still ready', async () => {
	installApp();
	writeFileSync(join(root, 'derived/stems/m1-instrumental.flac'), Buffer.alloc(10, 1));
	const body = (await (await call()).json()) as { alreadyReady?: boolean };
	expect(body.alreadyReady).toBe(true);
});
