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
import { LocalMediaStore, type MediaStore } from '$lib/server/media/store';
import { readSidecar, sidecarFromMedia, writeSidecar } from '$lib/server/media/sidecar';
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

function installApp(over: Partial<Media> = {}, mediaStore: Pick<MediaStore, 'exists'> = new LocalMediaStore()): Media {
	const db = migratedDb();
	const m: Media = {
		id: 'm1',
		source: 'local',
		sourceRef: 'library/m1.flac',
		title: 'm1',
		durationSec: 200,
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		...over
	};
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		now: () => 1_700_000_000_000,
		mediaById: new Map([['m1', m]]),
		state: new AuthoritativeState(),
		jobs: new JobRepository(db),
		singers: { bySessionToken: () => ({ id: 's1', displayName: 'Ada' }) },
		settings: new SettingsRepository(db),
		media: { upsert: () => {} },
		mediaStore,
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

type Body = { alreadyReady?: boolean; job?: { status: string } };

test('stems missing from the store: the pick starts a process and clears the sidecar', async () => {
	const m = installApp();
	await writeSidecar(sidecarFromMedia(m, 1_700_000_000_000));
	const body = (await (await call()).json()) as Body;
	expect(body.alreadyReady).toBeFalsy();
	expect(body.job?.status).toBe('queued');
	expect(m.stemStatus).toBe('queued');
	expect((await readSidecar('m1'))!.artifacts.instrumental).toBeNull();
});

test('CONTROL: stems in the store are still ready', async () => {
	installApp();
	writeFileSync(join(root, 'derived/stems/m1-instrumental.flac'), Buffer.alloc(10, 1));
	const body = (await (await call()).json()) as Body;
	expect(body.alreadyReady).toBe(true);
});

test('the stored ref is checked, not the default key: a present legacy .wav is ready', async () => {
	installApp({ instrumentalRef: 'derived/stems/m1-instrumental.wav' });
	writeFileSync(join(root, 'derived/stems/m1-instrumental.wav'), Buffer.alloc(10, 1));
	expect(((await (await call()).json()) as Body).alreadyReady).toBe(true);
});

test('a song that was never made asks the store nothing', async () => {
	let asked = 0;
	installApp({ stemStatus: 'none', instrumentalRef: undefined }, { exists: async () => (asked++, false) });
	expect(((await (await call()).json()) as Body).job?.status).toBe('queued');
	expect(asked).toBe(0);
});

test('a store that throws: the pick trusts the status, as before the check', async () => {
	installApp({}, { exists: () => Promise.reject(new Error('S3 down')) });
	const res = await call();
	expect(res.status).toBe(200);
	expect(((await res.json()) as Body).alreadyReady).toBe(true);
});

test('a store that never answers: the pick trusts the status after the 2 s bound', async () => {
	installApp({}, { exists: () => new Promise<boolean>(() => {}) });
	const started = Date.now();
	expect(((await (await call()).json()) as Body).alreadyReady).toBe(true);
	expect(Date.now() - started).toBeLessThan(4_000);
});
