// guard: #1162. A queue add (or Pick another) of a song that isn't ready any more never books a turn nothing will
// make: it starts the song's process as Sing does, or is refused with the reason. Through the real hub and
// `prepareTurn`, with the real job ledger and a file-backed media store.
import { test, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleQueueCommand, type HubDeps } from '$lib/server/realtime/hub';
import { prepareTurn } from '$lib/server/jobs/start-process';
import { reprioritizeProcessForMedia } from '$lib/server/jobs/reprioritize-process';
import { forgetProcess, NO_QUEUE_PRIORITY } from '$lib/server/jobs/process';
import { AuthoritativeState } from '$lib/server/state/store';
import { JobRepository } from '$lib/server/jobs/repository';
import { migratedDb } from '$lib/server/db/test-db';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { LocalMediaStore } from '$lib/server/media/store';
import { readSidecar, sidecarFromMedia, writeSidecar } from '$lib/server/media/sidecar';
import type { EncoreApp } from '$lib/server/app';
import {
	EMPTY_SONG_PROFILE,
	type ClientCommand,
	type Media,
	type QueueEntry,
	type QueueOp,
	type ServerEvent
} from '$lib/contract';

let root: string;
let saved: string | undefined;
beforeEach(() => {
	saved = process.env.MEDIA_DIR;
	root = mkdtempSync(join(tmpdir(), 'encore-add-'));
	process.env.MEDIA_DIR = root;
	mkdirSync(join(root, 'derived', 'stems'), { recursive: true });
});
afterEach(() => {
	if (saved === undefined) delete process.env.MEDIA_DIR;
	else process.env.MEDIA_DIR = saved;
	rmSync(root, { recursive: true, force: true });
});

const T0 = 1_700_000_000_000;
const song = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'local',
	sourceRef: `library/${id}.flac`,
	title: id,
	durationSec: 200,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: `derived/stems/${id}-instrumental.flac`,
	songProfile: EMPTY_SONG_PROFILE,
	...over
});
const onDisk = (id: string) => writeFileSync(join(root, `derived/stems/${id}-instrumental.flac`), Buffer.alloc(10, 1));

function room(songs: Media[], entries: QueueEntry[] = []) {
	const db = migratedDb();
	const state = new AuthoritativeState();
	state.hydrate(entries, null);
	const events: ServerEvent[] = [];
	const rejects: string[] = [];
	const ledger = new Set<string>();
	let dispatched = 0;
	const app = {
		now: () => T0,
		mediaById: new Map(songs.map((m) => [m.id, m])),
		state,
		jobs: new JobRepository(db),
		settings: new SettingsRepository(db),
		media: { upsert: () => {} },
		mediaStore: new LocalMediaStore(),
		publish: (e: ServerEvent) => void events.push(e),
		workerHub: { dispatch: () => void dispatched++, isUnservable: () => false }
	} as unknown as EncoreApp;
	const deps: HubDeps = {
		state,
		publish: app.publish,
		mediaById: app.mediaById,
		actorSingerId: 'theo',
		prepareAdd: (mediaId, singerId) => prepareTurn(app, mediaId, singerId),
		// As buildHubDeps wires it: the process is pulled to the new turn's place.
		onEntryAdded: (mediaId, entries) =>
			reprioritizeProcessForMedia(mediaId, {
				jobs: app.jobs,
				entries,
				now: app.now,
				dispatch: () => void dispatched++
			}),
		seenOp: (id) => (ledger.has(id) ? true : (ledger.add(id), false)),
		hasOp: (id) => ledger.has(id)
	};
	let n = 0;
	const send = (op: QueueOp) =>
		handleQueueCommand({ clientOpId: `c${++n}`, op } as ClientCommand, deps, (e) => {
			if (e.type === 'op:reject') rejects.push(e.reason);
		});
	const add = (mediaId: string, id = `e-${mediaId}`) =>
		send({ op: 'add', entry: { id, mediaId, singerId: 'theo', status: 'queued', addedAt: T0, rotationSeq: 0 } });
	return { app, state, events, rejects, ledger, add, send, dispatched: () => dispatched };
}
const turns = (state: AuthoritativeState) => state.entries.map((e) => e.mediaId);
const stemsJob = (app: EncoreApp, id: string) => app.jobs.findLive(id, 'stems');
/** Lets the store check and the process it may start settle. */
const settle = () => new Promise((r) => setTimeout(r, 50));

test('the repro: an evicted song added from a stale Library is made, not booked dead', async () => {
	const m = song('caroline');
	const r = room([m]);
	forgetProcess(m, r.app.jobs); // what the boot eviction pass does (retention.ts)
	r.add('caroline');
	expect(turns(r.state)).toEqual(['caroline']);
	expect(m.stemStatus).toBe('queued');
	// Pulled to the turn's place, not left behind every guest's pick.
	expect(stemsJob(r.app, 'caroline')?.priority).not.toBe(NO_QUEUE_PRIORITY);
	await settle();
	expect(r.events.some((e) => e.type === 'media:status' && e.mediaId === 'caroline')).toBe(true);
	expect(r.dispatched()).toBeGreaterThan(0);
});

test('a song still marked ready whose stems are gone from the store is booked, then made again', async () => {
	const m = song('caroline');
	await writeSidecar(sidecarFromMedia(m, T0));
	const r = room([m]);
	r.add('caroline');
	expect(turns(r.state)).toEqual(['caroline']);
	await settle();
	expect(m.stemStatus).toBe('queued');
	expect(stemsJob(r.app, 'caroline')?.status).toBe('queued');
	expect((await readSidecar('caroline'))!.artifacts.instrumental).toBeNull();
});

test('CONTROL: a ready song with its stems in the store starts nothing', async () => {
	const m = song('caroline');
	onDisk('caroline');
	const r = room([m]);
	r.add('caroline');
	await settle();
	expect(turns(r.state)).toEqual(['caroline']);
	expect(m.stemStatus).toBe('ready');
	expect(stemsJob(r.app, 'caroline')).toBeNull();
	expect(r.events.filter((e) => e.type === 'media:status')).toEqual([]);
});

test('a song already being made is booked onto its one job, never a second', async () => {
	const m = song('caroline', { stemStatus: 'queued', instrumentalRef: undefined, lyricsStatus: undefined });
	const r = room([m]);
	const live = r.app.jobs.enqueue('caroline', 'stems', NO_QUEUE_PRIORITY, T0);
	r.add('caroline');
	await settle();
	expect(turns(r.state)).toEqual(['caroline']);
	expect(stemsJob(r.app, 'caroline')?.id).toBe(live.id);
	expect(r.events.filter((e) => e.type === 'media:status')).toEqual([]);
});

test('a song that says it is being made with no job behind it gets one', async () => {
	const m = song('caroline', { stemStatus: 'queued', instrumentalRef: undefined, lyricsStatus: undefined });
	const r = room([m]);
	r.add('caroline');
	expect(stemsJob(r.app, 'caroline')?.status).toBe('queued');
});

test('a song nothing can make is refused with why, booked nowhere, and kept out of the op ledger', () => {
	const r = room([song('spot', { source: 'spotify', stemStatus: 'none', instrumentalRef: undefined })]);
	r.add('spot');
	expect(r.rejects).toEqual(['that’s a name match, not a playable song — search for it to make karaoke']);
	expect(turns(r.state)).toEqual([]);
	expect(r.ledger.size).toBe(0);
});

test('a singer at the process cap is refused the add with the same words as Sing', () => {
	const songs = ['a', 'b', 'c'].map((id) => song(id, { stemStatus: 'none', instrumentalRef: undefined }));
	const r = room(songs);
	r.app.settings.setGlobal({ maxProcessesPerSinger: 2 });
	r.add('a');
	r.add('b');
	r.add('c');
	expect(turns(r.state)).toEqual(['a', 'b']);
	expect(r.rejects).toEqual(['you already have 2 songs processing — wait for one to finish']);
	expect(stemsJob(r.app, 'c')).toBeNull();
});

test('Pick another onto an evicted song makes it too', async () => {
	const dead = song('dead');
	onDisk('dead');
	const next = song('next');
	const r = room([dead, next]);
	r.add('dead', 'turn');
	forgetProcess(next, r.app.jobs);
	r.send({ op: 'replace-media', id: 'turn', mediaId: 'next', keyShift: 0 });
	expect(turns(r.state)).toEqual(['next']);
	expect(stemsJob(r.app, 'next')?.status).toBe('queued');
});

test('a resend of an applied add is re-acked, never refused or made twice', () => {
	const r = room([song('caroline', { stemStatus: 'none', instrumentalRef: undefined })]);
	let asked = 0;
	const cmd = {
		clientOpId: 'again',
		op: {
			op: 'add',
			entry: { id: 'e1', mediaId: 'caroline', singerId: 'theo', status: 'queued', addedAt: T0, rotationSeq: 0 }
		}
	} as ClientCommand;
	const deps: HubDeps = {
		state: r.state,
		publish: r.app.publish,
		mediaById: r.app.mediaById,
		actorSingerId: 'theo',
		prepareAdd: () => (asked++, 'refused'),
		seenOp: () => true,
		hasOp: () => true
	};
	handleQueueCommand(cmd, deps, () => r.rejects.push('rejected'));
	expect(asked).toBe(0);
	expect(r.rejects).toEqual([]);
});
