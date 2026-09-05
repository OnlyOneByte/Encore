// Done-when: a fake worker socket drives a job to `ready`. Also covers welcome handshake,
// dispatch-on-hello, progress→media:status rebroadcast, reject/requeue, retryable vs terminal
// failure, and need-ordered dispatch across workers. No real socket — sinks capture the effects.
import { test, expect } from 'bun:test';
import { WorkerHub } from './worker-hub';
import { WorkerRegistry } from './registry';
import { JobRepository } from './repository';
import { AttemptLedger } from './attempts';
import { openDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { attemptStages, realtimeFactor, DEFAULT_EFFECTIVE_SETTINGS, type EffectiveSettings, type WorkerCommand, type ServerEvent, type Media } from '@encore/shared';

const T0 = 1_700_000_000_000;

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id, source: 'youtube', sourceRef: 'vid-' + id, title: id, durationSec: 200, stemStatus: 'none', ...over
});

function harness() {
	const { db } = openDb(':memory:');
	runMigrations(db);
	const attempts = new AttemptLedger(db);
	const jobs = new JobRepository(db, attempts);
	const registry = new WorkerRegistry();
	const mediaById = new Map<string, Media>([['m1', media('m1')], ['m2', media('m2')]]);
	const sent: { workerId: string; cmd: WorkerCommand }[] = [];
	const broadcasts: ServerEvent[] = [];
	let clock = T0;
	const readied: string[] = [];
	const hub = new WorkerHub({
		jobs,
		attempts,
		registry,
		mediaById,
		toWorker: (workerId, cmd) => sent.push({ workerId, cmd }),
		broadcast: (e) => broadcasts.push(e),
		onMediaReady: (mediaId) => readied.push(mediaId),
		now: () => clock
	});
	return { hub, jobs, attempts, registry, mediaById, sent, broadcasts, readied, setClock: (t: number) => (clock = t) };
}

const cmdsOfType = (sent: { cmd: WorkerCommand }[], type: WorkerCommand['type']) =>
	sent.filter((s) => s.cmd.type === type).map((s) => s.cmd);

test('hello → welcome handshake + dispatch of a waiting job', () => {
	const { hub, jobs, sent } = harness();
	jobs.enqueue('m1', 'stems', 0, T0); // a job is already waiting

	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });

	const welcome = cmdsOfType(sent, 'worker:welcome')[0] as Extract<WorkerCommand, { type: 'worker:welcome' }>;
	expect(welcome).toMatchObject({ type: 'worker:welcome', ackTimeoutSec: 10, heartbeatIntervalSec: 30 });
	expect(welcome.mediaStore).toEqual({ kind: 'local' }); // default single-box store
	const assign = cmdsOfType(sent, 'job:assign')[0] as Extract<WorkerCommand, { type: 'job:assign' }>;
	expect(assign).toBeTruthy();
	expect(assign.mediaId).toBe('m1');
	expect(assign.jobType).toBe('stems');
	expect(assign.sourceUri).toContain('youtube.com/watch?v=vid-m1');
	expect(assign.params.model).toBe('htdemucs');
});

test('welcome carries the object-store config so a remote worker pulls/pushes via S3', () => {
	const { db } = openDb(':memory:');
	runMigrations(db);
	const jobs = new JobRepository(db);
	const sent: { workerId: string; cmd: WorkerCommand }[] = [];
	const hub = new WorkerHub({
		jobs,
		registry: new WorkerRegistry(),
		mediaById: new Map<string, Media>(),
		toWorker: (workerId, cmd) => sent.push({ workerId, cmd }),
		broadcast: () => {},
		mediaStore: { kind: 'object', bucket: 'encore-media', endpoint: 'https://minio.lan:9000', prefix: 'encore/' },
		now: () => T0
	});
	hub.handle({ type: 'worker:hello', workerId: 'remote-w', capabilities: ['stems'], concurrency: 1, version: '1' });
	const welcome = cmdsOfType(sent, 'worker:welcome')[0] as Extract<WorkerCommand, { type: 'worker:welcome' }>;
	expect(welcome.mediaStore).toEqual({ kind: 'object', bucket: 'encore-media', endpoint: 'https://minio.lan:9000', prefix: 'encore/' });
});

test('FULL LIFECYCLE: hello → assign → accept → progress → complete drives the job to ready', () => {
	const { hub, jobs, registry, mediaById, broadcasts, setClock } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	expect(jobs.byId(job.id)!.status).toBe('assigned');
	expect(registry.get('w1')!.slotsFree).toBe(0); // slot claimed on dispatch

	setClock(T0 + 1000);
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	expect(jobs.byId(job.id)!.status).toBe('running');
	expect(jobs.byId(job.id)!.leaseExpiresAt).toBe(T0 + 1000 + 30_000); // fresh progress lease

	setClock(T0 + 2000);
	hub.handle({ type: 'job:progress', workerId: 'w1', jobId: job.id, stage: 'separating', pct: 68, etaSec: 12 });
	const sep = broadcasts.at(-1) as Extract<ServerEvent, { type: 'media:status' }>;
	expect(sep).toMatchObject({ type: 'media:status', mediaId: 'm1', status: 'separating', pct: 68, etaSec: 12 });

	setClock(T0 + 3000);
	hub.handle({ type: 'job:complete', workerId: 'w1', jobId: job.id, mediaUri: 'media/m1-instrumental.mp3' });
	const done = jobs.byId(job.id)!;
	expect(done.status).toBe('ready'); // ← drove to ready
	expect(done.progressPct).toBe(100);
	// Media flips to the playable instrumental (instrumentalRef→stems key).
	// sourceRef stays the ORIGIN so search still recognises the song as already cooked.
	const m = mediaById.get('m1')!;
	expect(m.stemStatus).toBe('ready');
	expect(m.instrumentalRef).toBe('derived/stems/m1-instrumental.flac');
	expect(m.sourceRef).toBe('vid-m1');
	const ready = broadcasts.at(-1) as Extract<ServerEvent, { type: 'media:status' }>;
	expect(ready).toMatchObject({ type: 'media:status', mediaId: 'm1', status: 'ready' });
	expect(registry.get('w1')!.slotsFree).toBe(1); // slot released on complete → free for new work
});

test('complete fires onMediaReady so the core reconciles playback', () => {
	const { hub, jobs, mediaById, readied } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	expect(readied).toEqual([]); // not until complete
	hub.handle({ type: 'job:complete', workerId: 'w1', jobId: job.id, mediaUri: 'x' });
	expect(readied).toEqual(['m1']); // fired exactly once, after the media flip
	expect(mediaById.get('m1')!.stemStatus).toBe('ready');
});

test('idempotency: accept/progress/complete from the WRONG worker or wrong state are ignored', () => {
	const { hub, jobs } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });

	// a different worker can't accept someone else's job
	hub.handle({ type: 'job:accept', workerId: 'w-evil', jobId: job.id });
	expect(jobs.byId(job.id)!.status).toBe('assigned');
	// progress before accept (still assigned, not running) is ignored
	hub.handle({ type: 'job:progress', workerId: 'w1', jobId: job.id, stage: 'separating', pct: 10 });
	expect(jobs.byId(job.id)!.progressPct).toBe(0);
});

test('job:reject → back to queued (no attempt burned), slot freed, redispatched', () => {
	const { hub, jobs, registry, sent } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	expect(registry.get('w1')!.slotsFree).toBe(0); // claimed on dispatch

	hub.handle({ type: 'job:reject', workerId: 'w1', jobId: job.id, reason: 'busy' });
	const after = jobs.byId(job.id)!;
	expect(after.attempts).toBe(0); // never ran
	// slot was released then immediately re-claimed by the redispatch to the same worker
	expect(after.status).toBe('assigned');
	expect(cmdsOfType(sent, 'job:assign')).toHaveLength(2); // initial + redispatch
});

test('job:failed retryable with attempts left → requeue + redispatch; exhausted → failed', () => {
	const { hub, jobs, setClock } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });

	// 3 attempts (maxAttempts default 3): the first two retry (requeue → immediately redispatched to
	// the now-free worker, so status returns to 'assigned'); the third exhausts → terminal failed.
	for (let i = 1; i <= 3; i++) {
		setClock(T0 + i * 1000);
		hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
		hub.handle({ type: 'job:failed', workerId: 'w1', jobId: job.id, error: 'demucs blew up', retryable: true });
		const j = jobs.byId(job.id)!;
		expect(j.attempts).toBe(i);
		if (i < 3) {
			expect(j.status).toBe('assigned'); // requeued then redispatched (transient failure, keep trying)
		} else {
			expect(j.status).toBe('failed'); // attempts exhausted → terminal
			expect(j.error).toBe('demucs blew up');
		}
	}
});

test('non-retryable failure fails immediately even with attempts left', () => {
	const { hub, jobs } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	hub.handle({ type: 'job:failed', workerId: 'w1', jobId: job.id, error: 'source gone (404)', retryable: false });
	const j = jobs.byId(job.id)!;
	expect(j.status).toBe('failed');
	expect(j.attempts).toBe(1);
});

test('dispatch is need-ordered: the sooner-needed job (lower priority) is assigned to the one slot', () => {
	const { hub, jobs, sent } = harness();
	jobs.enqueue('m2', 'stems', 9, T0); // far away in rotation
	jobs.enqueue('m1', 'stems', 1, T0); // up next
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	const assigns = cmdsOfType(sent, 'job:assign') as Extract<WorkerCommand, { type: 'job:assign' }>[];
	expect(assigns).toHaveLength(1);
	expect(assigns[0].mediaId).toBe('m1'); // the up-next song wins the slot
});

test('a job with no capable worker stays queued (unservable by the current fleet)', () => {
	const { hub, jobs, sent } = harness();
	const job = jobs.enqueue('m1', 'align', 0, T0); // needs align
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' }); // only stems
	expect(jobs.byId(job.id)!.status).toBe('queued');
	expect(cmdsOfType(sent, 'job:assign')).toHaveLength(0);
});

// ── an unservable job must not park queued FOREVER (TTL → terminal failed) ──
// Without a ceiling a job whose capability no connected worker advertises never reaches a terminal
// state, so the TV/phone wait indefinitely. After UNSERVABLE_TTL_MS (~120s) it must move to `failed`
// via jobs.fail so #emitStatus broadcasts `failed`.
test('an unservable job past the TTL is failed and broadcasts failed', () => {
	const { hub, jobs, broadcasts, setClock } = harness();
	const job = jobs.enqueue('m1', 'align', 0, T0); // needs align capability
	// A worker connects that can NEVER serve it → job first seen unservable at T0.
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	expect(jobs.byId(job.id)!.status).toBe('queued');

	// Just under the TTL: still queued, not failed.
	setClock(T0 + 119_000);
	hub.dispatch();
	expect(jobs.byId(job.id)!.status).toBe('queued');

	// Past the TTL: terminal failed, and a media:status 'failed' is broadcast.
	setClock(T0 + 121_000);
	hub.dispatch();
	const failed = jobs.byId(job.id)!;
	expect(failed.status).toBe('failed');
	expect(failed.error).toContain('align');
	const last = broadcasts.at(-1) as Extract<ServerEvent, { type: 'media:status' }>;
	expect(last).toMatchObject({ type: 'media:status', mediaId: 'm1', status: 'failed' });
});

test('a job that finds a worker before the TTL is unaffected (no spurious fail)', () => {
	const { hub, jobs, setClock } = harness();
	const job = jobs.enqueue('m1', 'align', 0, T0); // needs align
	// Only a stems worker at first → unservable, first-seen at T0.
	hub.handle({ type: 'worker:hello', workerId: 'w-stems', capabilities: ['stems'], concurrency: 1, version: '1' });
	expect(jobs.byId(job.id)!.status).toBe('queued');

	// Well before the TTL, an align-capable worker joins → job is assigned, not failed.
	setClock(T0 + 30_000);
	hub.handle({ type: 'worker:hello', workerId: 'w-align', capabilities: ['align'], concurrency: 1, version: '1' });
	expect(jobs.byId(job.id)!.status).toBe('assigned');

	// Even far past when the TTL WOULD have fired, the (now assigned) job is untouched: the unservable
	// tracking was pruned the moment it found a worker, so a later stall can't retroactively fail it.
	setClock(T0 + 200_000);
	hub.dispatch();
	expect(jobs.byId(job.id)!.status).toBe('assigned');
});

// ── the attempt ledger, driven through the real wire path ────────────────────────
// These assert the full journey a duration takes: dispatch writes what was ASKED, the worker's
// job:complete overwrites it with what actually RAN, and the row is sealed with its timings.

test('a full cook records its timings, models and stage split on the attempt', () => {
	const { hub, jobs, attempts, setClock } = harness();
	jobs.enqueue('m1', 'stems', 0, T0);
	setClock(T0 + 5_000); // 5s of queue wait
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	setClock(T0 + 6_000);
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: jobs.listByStatus('assigned')[0].id });
	const jobId = jobs.listByStatus('running')[0].id;
	setClock(T0 + 96_000); // 90s of actual work
	hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId,
		mediaUri: '/media/derived/stems/m1-instrumental.flac',
		artifacts: { stems: { instrumental: '/media/derived/stems/m1-instrumental.flac' } },
		facts: { engine: 'demucs', model: 'htdemucs', backend: 'torch' },
		stages: [
			{ stage: 'downloading', ms: 9_000 },
			{ stage: 'separating', ms: 81_000 }
		]
	});

	const [a] = attempts.byMedia('m1');
	expect(a.outcome).toBe('ready');
	expect(a.assignedAt! - a.enqueuedAt).toBe(5_000); // queue wait, separated at last
	expect(a.finishedAt! - a.startedAt!).toBe(90_000); // processing time
	expect(a.model).toBe('htdemucs');
	expect(a.backend).toBe('torch');
	// The split the core could never see on its own.
	expect(attemptStages(a)).toEqual([
		{ stage: 'downloading', ms: 9_000 },
		{ stage: 'separating', ms: 81_000 }
	]);
	// media durationSec is 200 in this harness → 90s of compute for 200s of audio.
	expect(realtimeFactor(a)).toBeCloseTo(0.45, 5);
});

test("the worker's resolved model wins over what dispatch asked for", () => {
	const { hub, jobs, attempts, setClock } = harness();
	jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: jobs.listByStatus('assigned')[0].id });
	const jobId = jobs.listByStatus('running')[0].id;
	setClock(T0 + 1_000);
	hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId,
		mediaUri: '/media/x.flac',
		artifacts: { stems: { instrumental: '/media/x.flac' } },
		// The core asked for the default; the worker actually loaded a different checkpoint.
		facts: { engine: 'roformer', model: 'mel-band-roformer', device: 'cpu' }
	});

	const [a] = attempts.byMedia('m1');
	expect(a.model).toBe('mel-band-roformer');
	expect(a.device).toBe('cpu');
});

test('an older worker that reports no facts still gets a sealed, timed attempt', () => {
	// The wire fields are additive: a worker built before this change sends neither, and the attempt
	// must still carry the timings the CORE measured rather than being left open forever.
	const { hub, jobs, attempts, setClock } = harness();
	jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: jobs.listByStatus('assigned')[0].id });
	const jobId = jobs.listByStatus('running')[0].id;
	setClock(T0 + 30_000);
	hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId,
		mediaUri: '/media/x.flac',
		artifacts: { stems: { instrumental: '/media/x.flac' } }
	});

	const [a] = attempts.byMedia('m1');
	expect(a.outcome).toBe('ready');
	expect(a.finishedAt! - a.startedAt!).toBe(30_000);
	expect(attemptStages(a)).toEqual([]); // no breakdown, honestly empty
	expect(a.model).toBe('htdemucs'); // what dispatch asked for still stands
});

test('a terminally failed stems job settles the media back to un-cooked and says so', () => {
	// The phantom cook: #onFailed used to leave stemStatus mid-flight, so isCooking stayed true, the
	// phone row read "Making karaoke… 0%" forever and cookState refused a retry. One worker OOM made
	// the song permanently unsingable with no way out but a DB edit.
	const { hub, jobs, mediaById, broadcasts } = harness();
	// enqueue alone does not touch the media; requestMakeKaraoke is what marks it in flight, so set the
	// state that a real cook would have left behind.
	mediaById.set('m1', media('m1', { stemStatus: 'queued' }));
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	expect(mediaById.get('m1')!.stemStatus).toBe('queued'); // in flight

	hub.handle({ type: 'job:failed', workerId: 'w1', jobId: job.id, error: 'CUDA OOM', retryable: false });

	expect(jobs.byId(job.id)!.status).toBe('failed');
	expect(mediaById.get('m1')!.stemStatus).toBe('none'); // settled — retryable again
	// And the phone is told, so the row can render the failure rather than a stalled progress line.
	const statuses = broadcasts.filter((e) => e.type === 'media:status');
	expect(statuses.at(-1)).toMatchObject({ type: 'media:status', mediaId: 'm1', status: 'failed' });
});

test('a failed ALIGN leaves a separated song singable — it does not settle the stems side', () => {
	// The asymmetry is deliberate: a dead lyrics step must not throw away a good instrumental.
	const { hub, jobs, mediaById } = harness();
	mediaById.set('m1', media('m1', { stemStatus: 'ready', instrumentalRef: 'derived/stems/m1-instrumental.flac' }));
	const job = jobs.enqueue('m1', 'align', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['align'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	hub.handle({ type: 'job:failed', workerId: 'w1', jobId: job.id, error: 'model would not load', retryable: false });

	expect(mediaById.get('m1')!.stemStatus).toBe('ready'); // instrumental preserved
	expect(mediaById.get('m1')!.lyricsStatus).toBe('ready'); // lyrics gate settled instead
});

test('a terminally failed FETCH also settles the media — the common stranding case', () => {
	// requestMakeKaraoke marks the media cooking BEFORE the download, so a dead fetch stranded it
	// exactly like a dead separation. This was the more likely of the two in practice: a missing deno
	// or a broken yt-dlp fails every fetch on the box.
	const { hub, jobs, mediaById } = harness();
	mediaById.set('m1', media('m1', { stemStatus: 'queued' }));
	const job = jobs.enqueue('m1', 'fetch', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['fetch:ytdlp'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	hub.handle({ type: 'job:failed', workerId: 'w1', jobId: job.id, error: 'Requested format is not available', retryable: false });

	expect(mediaById.get('m1')!.stemStatus).toBe('none');
});

// ── FIX 3: a REFUSED stems-upgrade must change NOTHING on the song ────────────────────────────────
// markMediaReady refuses (returns false) an upgrade whose separator does not outrank the published
// one. The two artifact setters were called unconditionally regardless, and setMediaSongProfile
// normalizes an absent profile to EMPTY_SONG_PROFILE — so a refused upgrade WIPED the detected key
// and vocal range off a song that already had them. The fix guards both setters on the accept.
test('a refused stems-upgrade leaves the key, range, vocals and instrumental untouched', () => {
	const { hub, jobs, mediaById } = harness();
	// A song already cooked at the TOP of the quality ladder (ensemble, rank 45), with a real key +
	// range profile and a guiding-vocals ref.
	const profile = {
		keyTonic: 3, keyMode: 'major', keyConfidence: 0.9,
		lowMidi: 50, highMidi: 72, p05Midi: 55, p95Midi: 67, histogram: [1, 2, 3]
	};
	mediaById.set('m1', media('m1', {
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		separator: { engine: 'ensemble', model: 'instrumental_clean' }, // rank 45
		vocalsRef: 'derived/stems/m1-vocals.flac',
		songProfile: profile as unknown as Media['songProfile']
	}));
	// A stems-upgrade completes. With no settings the harness resolves the upgrade to the default
	// roformer:bs-roformer-1297 (rank 35), which does NOT outrank the published ensemble — so
	// markMediaReady refuses it.
	const job = jobs.enqueue('m1', 'stems-upgrade', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems:roformer'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId: job.id,
		mediaUri: 'x',
		artifacts: {
			stems: { instrumental: 'derived/stems/m1-instrumental-UPGRADE.flac', vocals: 'derived/stems/m1-vocals-UPGRADE.flac' }
			// no songProfile on this frame — the exact condition that used to normalize to EMPTY and wipe
		}
	});

	const m = mediaById.get('m1')!;
	// The refusal is a no-op: none of the artifacts moved.
	expect(m.instrumentalRef).toBe('derived/stems/m1-instrumental.flac'); // NOT the UPGRADE key
	expect(m.vocalsRef).toBe('derived/stems/m1-vocals.flac'); // NOT the UPGRADE vocals
	expect(m.songProfile).toEqual(profile as unknown as Media['songProfile']); // key + range preserved
	expect(m.separator).toEqual({ engine: 'ensemble', model: 'instrumental_clean' }); // still the better one
});

test('an ACCEPTED stems-upgrade DOES swap the artifacts (the guard is not over-eager)', () => {
	const { hub, jobs, mediaById } = harness();
	// Published at the BOTTOM of the ladder (demucs htdemucs, rank 10); the default upgrade (roformer,
	// rank 35) outranks it, so markMediaReady accepts and the setters run.
	mediaById.set('m1', media('m1', {
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		separator: { engine: 'demucs', model: 'htdemucs' } // rank 10
	}));
	const job = jobs.enqueue('m1', 'stems-upgrade', 0, T0);
	// The default upgrade engine is roformer, so the job routes to a stems:roformer worker.
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems:roformer'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId: job.id,
		mediaUri: 'x',
		artifacts: { stems: { instrumental: 'derived/stems/m1-instrumental-UPGRADE.flac' } }
	});

	const m = mediaById.get('m1')!;
	expect(m.instrumentalRef).toBe('derived/stems/m1-instrumental-UPGRADE.flac'); // upgraded
	expect(m.separator).toEqual({ engine: 'roformer', model: 'bs-roformer-1297' }); // and recorded
});

// ── FIX 4: the room's downward-only quality ceiling must reach dispatch ───────────────────────────
// resolveCookSeparator was complete, tested, and had ZERO non-test callers: dispatch read
// global.defaultEngine/defaultModel directly, so a room set to a lower quality was ignored. The hub
// now folds resolveCookSeparator over the effective settings before handing them to dispatch, which
// must lower BOTH the assigned engine/model AND the capability the stems job is routed by.

function hubWithSettings(getSettings: () => EffectiveSettings) {
	const { db } = openDb(':memory:');
	runMigrations(db);
	const jobs = new JobRepository(db);
	const registry = new WorkerRegistry();
	const mediaById = new Map<string, Media>([['m1', media('m1')]]);
	const sent: { workerId: string; cmd: WorkerCommand }[] = [];
	const hub = new WorkerHub({
		jobs, registry, mediaById,
		toWorker: (workerId, cmd) => sent.push({ workerId, cmd }),
		broadcast: () => {},
		getSettings,
		now: () => T0
	});
	return { hub, jobs, sent };
}

const assignOf = (sent: { cmd: WorkerCommand }[]) =>
	sent.filter((s) => s.cmd.type === 'job:assign').map((s) => s.cmd)[0] as Extract<WorkerCommand, { type: 'job:assign' }>;

test('a room quality ceiling LOWERS the stems engine, model, and routing capability', () => {
	// Global default is a high-tier roformer cook; the room caps quality down to the demucs tier.
	const effective: EffectiveSettings = {
		global: { ...DEFAULT_EFFECTIVE_SETTINGS.global, defaultEngine: 'roformer', defaultModel: 'bs-roformer-1297' }, // rank 35
		room: { ...DEFAULT_EFFECTIVE_SETTINGS.room, maxQualityRank: 10 } // cap at the demucs:htdemucs tier
	};
	const { hub, jobs, sent } = hubWithSettings(() => effective);
	jobs.enqueue('m1', 'stems', 0, T0);
	// A demucs-only worker: it could NOT serve a roformer cook, so the fact it gets the job proves the
	// capability was lowered to 'stems' (demucs), not left at 'stems:roformer'.
	hub.handle({ type: 'worker:hello', workerId: 'w-demucs', capabilities: ['stems'], concurrency: 1, version: '1' });

	const assign = assignOf(sent);
	expect(assign).toBeTruthy(); // routed to the demucs worker → capability was lowered
	expect(assign.params.engine).toBe('demucs'); // engine lowered
	expect(assign.params.model).toBe('htdemucs'); // model lowered to the capped tier
});

test('with NO room cap, dispatch uses the global default unchanged (ceiling is downward-only)', () => {
	const effective: EffectiveSettings = {
		global: { ...DEFAULT_EFFECTIVE_SETTINGS.global, defaultEngine: 'roformer', defaultModel: 'bs-roformer-1297' },
		room: { ...DEFAULT_EFFECTIVE_SETTINGS.room, maxQualityRank: null } // no cap
	};
	const { hub, jobs, sent } = hubWithSettings(() => effective);
	jobs.enqueue('m1', 'stems', 0, T0);
	// The roformer worker is required now: an uncapped high-tier cook must route to 'stems:roformer'.
	hub.handle({ type: 'worker:hello', workerId: 'w-rof', capabilities: ['stems:roformer'], concurrency: 1, version: '1' });

	const assign = assignOf(sent);
	expect(assign).toBeTruthy();
	expect(assign.params.engine).toBe('roformer'); // global default preserved, never raised or altered
	expect(assign.params.model).toBe('bs-roformer-1297');
});
