// Done-when: a fake worker socket drives a job to `ready`. Also covers welcome handshake,
// dispatch-on-hello, progress→media:status rebroadcast, reject/requeue, retryable vs terminal
// failure, and need-ordered dispatch across workers. No real socket — sinks capture the effects.
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { WorkerHub } from '$lib/server/jobs/worker-hub';
import { WorkerRegistry } from '$lib/server/jobs/registry';
import { JobRepository } from '$lib/server/jobs/repository';
import { AttemptLedger } from '$lib/server/jobs/attempts';
import { attemptSelection } from '$lib/contract';
import {
	attemptStages,
	realtimeFactor,
	DEFAULT_EFFECTIVE_SETTINGS,
	type EffectiveSettings,
	type WorkerCommand,
	type ServerEvent,
	type Media
} from '$lib/contract';

const T0 = 1_700_000_000_000;

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'none',
	...over
});

function harness() {
	const db = migratedDb();
	const attempts = new AttemptLedger(db);
	const jobs = new JobRepository(db, attempts);
	const registry = new WorkerRegistry();
	const mediaById = new Map<string, Media>([
		['m1', media('m1')],
		['m2', media('m2')]
	]);
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
	// heartbeatIntervalSec is HALF the 30s progress lease: a worker honouring it has room for
	// one dropped tick before breaching. The derived-value invariant is pinned in vocabulary-parity.test.ts.
	expect(welcome).toMatchObject({ type: 'worker:welcome', ackTimeoutSec: 10, heartbeatIntervalSec: 15 });
	expect(welcome.mediaStore).toEqual({ kind: 'local' }); // default single-box store
	const assign = cmdsOfType(sent, 'job:assign')[0] as Extract<WorkerCommand, { type: 'job:assign' }>;
	expect(assign).toBeTruthy();
	expect(assign.mediaId).toBe('m1');
	expect(assign.jobType).toBe('stems');
	expect(assign.sourceUri).toContain('youtube.com/watch?v=vid-m1');
	expect(assign.params.model).toBe('htdemucs');
});

test('welcome carries the object-store config so a remote worker pulls/pushes via S3', () => {
	const db = migratedDb();
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
	expect(welcome.mediaStore).toEqual({
		kind: 'object',
		bucket: 'encore-media',
		endpoint: 'https://minio.lan:9000',
		prefix: 'encore/'
	});
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
	// sourceRef stays the ORIGIN so search still recognises the song as already processed.
	const m = mediaById.get('m1')!;
	expect(m.stemStatus).toBe('ready');
	expect(m.instrumentalRef).toBe('derived/stems/m1-instrumental.flac');
	expect(m.sourceRef).toBe('vid-m1');
	// The SONG is not ready — separation finished but its words are not timed yet, and the align job
	// this completion just enqueued is what the room is now waiting on. This assertion used to read
	// `status: 'ready'`, which pinned a real defect as correct: every completed job mapped to 'ready'
	// regardless of type, so a finished fetch OR a finished separation told every phone the song was
	// singable, and readiness.ts lets a live 'ready' override the catalog (entryPlayable said yes for a
	// song whose instrumental did not exist yet). See jobs/media-status.ts.
	const afterStems = broadcasts.at(-1) as Extract<ServerEvent, { type: 'media:status' }>;
	expect(afterStems).toMatchObject({ type: 'media:status', mediaId: 'm1', status: 'aligning' });
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

// ── one test per worker-frame GUARD ARM ──────────────────────────────────────────
// Every worker-message handler shares the same stale-frame guard:
//   if (!job || job.status !== '<expected>' || job.workerId !== msg.workerId) return;
// The idempotency test above drives only #onAccept's workerId arm (w-evil) and #onProgress's
// status arm (progress-before-accept). The remaining EIGHT arms had no test, so weakening any of
// them — most dangerously #onComplete's — was invisible to the suite. Each test below reaches a
// state where the named arm is the SOLE defence (the other two clauses in the guard PASS), so
// deleting exactly that arm turns exactly that test red. Deletion was verified per-arm.

// Drive a job to `running` owned by w1 and return its id.
function running(h: ReturnType<typeof harness>, worker = 'w1') {
	const job = h.jobs.enqueue('m1', 'stems', 0, T0);
	h.hub.handle({ type: 'worker:hello', workerId: worker, capabilities: ['stems'], concurrency: 1, version: '1' });
	h.hub.handle({ type: 'job:accept', workerId: worker, jobId: job.id });
	return job.id;
}

test('guard arm — #onAccept status: a second accept on an already-running job is ignored (no lease re-stamp)', () => {
	const h = harness();
	const jobId = running(h); // status is now 'running', workerId 'w1'
	const leaseAfterFirst = h.jobs.byId(jobId)!.leaseExpiresAt;
	// A duplicate accept from the SAME worker: workerId matches, so the STATUS arm ('assigned') is the
	// only thing that can refuse. If it did not, accept() would re-stamp a fresh progress lease.
	h.setClock(T0 + 50_000);
	h.hub.handle({ type: 'job:accept', workerId: 'w1', jobId });
	expect(h.jobs.byId(jobId)!.status).toBe('running');
	expect(h.jobs.byId(jobId)!.leaseExpiresAt).toBe(leaseAfterFirst); // lease NOT refreshed
});

test('guard arm — #onReject workerId: a reject from the wrong worker is ignored (job stays assigned)', () => {
	const { hub, jobs } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	// status is 'assigned' (matches the reject guard), so only the workerId arm can refuse w-evil.
	hub.handle({ type: 'job:reject', workerId: 'w-evil', jobId: job.id, reason: 'busy' });
	expect(jobs.byId(job.id)!.status).toBe('assigned'); // NOT requeued by the impostor
});

test('guard arm — #onReject status: a reject after the job is running is ignored (no requeue)', () => {
	const h = harness();
	const jobId = running(h); // status 'running', workerId 'w1' — workerId matches the reject
	// A reject only makes sense while 'assigned'; once running the STATUS arm must refuse it, else the
	// job would be requeued mid-run and the slot double-freed.
	h.hub.handle({ type: 'job:reject', workerId: 'w1', jobId, reason: 'changed my mind' });
	expect(h.jobs.byId(jobId)!.status).toBe('running'); // still running, not walked back to queued
});

test('guard arm — #onProgress workerId: a progress frame from the wrong worker is ignored', () => {
	const h = harness();
	const jobId = running(h); // status 'running' (matches the progress guard), workerId 'w1'
	// Only the workerId arm can refuse a progress frame forged by another worker.
	h.hub.handle({ type: 'job:progress', workerId: 'w-evil', jobId, stage: 'separating', pct: 77 });
	expect(h.jobs.byId(jobId)!.progressPct).toBe(0); // impostor's progress not applied
});

test('guard arm — #onComplete workerId: a ZOMBIE worker cannot publish over the live owner', () => {
	const h = harness();
	const { hub, jobs, mediaById, registry } = h;
	// w1 accepts and runs, then a redispatch hands the job to w2 (the reaper-requeue path). We model the
	// end state directly: the job is running and OWNED BY w2, while w1 is still alive.
	const jobId = running(h, 'w1'); // running, workerId 'w1'
	jobs.requeue(jobId, jobs.byId(jobId)!.attempts, T0 + 1_000); // reaper requeues the (still-live) job
	hub.handle({ type: 'worker:hello', workerId: 'w2', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w2', jobId }); // w2 now owns it
	expect(jobs.byId(jobId)!.workerId).toBe('w2');
	const w1SlotsBefore = registry.get('w1')!.slotsFree;
	// The zombie w1 finally sends its stale completion. status is 'running' (matches), so the workerId
	// arm is the ONLY guard. If it were weakened the zombie's instrumental would be published PERMANENTLY
	// and w2's real completion then silently dropped (status already 'ready').
	hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId,
		mediaUri: 'zombie',
		artifacts: { stems: { instrumental: 'derived/stems/m1-ZOMBIE.flac' } }
	});
	expect(jobs.byId(jobId)!.status).toBe('running'); // NOT flipped to ready by the zombie
	expect(mediaById.get('m1')!.stemStatus).toBe('none'); // no stale instrumental published
	expect(mediaById.get('m1')!.instrumentalRef).toBeUndefined();
	expect(registry.get('w1')!.slotsFree).toBe(w1SlotsBefore); // no slot released for a job w1 does not own
});

test('guard arm — #onComplete status: a complete while still assigned is ignored, never throws', () => {
	const { hub, jobs, mediaById } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	// status is 'assigned' (never accepted), workerId matches w1 → the STATUS arm is the sole guard.
	// jobs.complete() would attempt assigned→ready, an illegal transition that THROWS out of the
	// unguarded server.ts message handler, ending the socket. The guard must swallow it.
	expect(() => hub.handle({ type: 'job:complete', workerId: 'w1', jobId: job.id, mediaUri: 'x' })).not.toThrow();
	expect(jobs.byId(job.id)!.status).toBe('assigned'); // untouched
	expect(mediaById.get('m1')!.stemStatus).toBe('none'); // nothing published
});

test('guard arm — #onFailed workerId: a failure frame from the wrong worker is ignored', () => {
	const h = harness();
	const jobId = running(h); // running, workerId 'w1'
	const attemptsBefore = h.jobs.byId(jobId)!.attempts;
	// status 'running' matches the fail guard → only the workerId arm can refuse the impostor.
	h.hub.handle({ type: 'job:failed', workerId: 'w-evil', jobId, error: 'not mine to fail', retryable: false });
	expect(h.jobs.byId(jobId)!.status).toBe('running'); // still running
	expect(h.jobs.byId(jobId)!.attempts).toBe(attemptsBefore); // no attempt burned by the impostor
});

test('guard arm — #onFailed status: a failure while still assigned (not running) is ignored', () => {
	const { hub, jobs } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	// status 'assigned', workerId matches w1 → the STATUS arm ('running') is the sole guard. A failure
	// before the job ever ran must not burn an attempt or move it off 'assigned'.
	hub.handle({ type: 'job:failed', workerId: 'w1', jobId: job.id, error: 'premature', retryable: false });
	expect(jobs.byId(job.id)!.status).toBe('assigned');
	expect(jobs.byId(job.id)!.attempts).toBe(0);
});

// ── the `!job` arm: a frame naming a jobId with NO row is swallowed, never throws ──────────────────
// Sibling of (the status/workerId arms). Every handler's guard is
//   if (!job || job.status !== '<expected>' || job.workerId !== msg.workerId) return;
// and the tests above only ever drive frames whose jobId EXISTS, so `job` is always truthy and the
// leading `!job` arm never fires. Delete it from any handler and the suite stays green — the exact
// mutation this issue reproduces. With `!job` gone, `byId` returns undefined for an unknown id and
// `job.status` dereferences undefined, throwing a TypeError straight out of the unguarded
// server.ts:212 message handler (its only try/catch wraps the JSON.parse), which ends the
// worker socket: "one malformed frame must never end a party". Each test below fires a WELL-FORMED
// frame carrying a jobId that was never enqueued, so `!job` is the SOLE defence (there is no row for
// the status/workerId arms to read), and asserts .not.toThrow() plus that nothing was created or
// emitted. Deletion was verified per-arm (delete `!job || ` from one handler, that handler's test reds).

// A jobId that no repository row will ever match. `byId` returns undefined for it, so the `!job` arm
// is the only guard standing between the frame and a dereference of `undefined.status`.
const GHOST = 'ghost-job-does-not-exist';

test('guard arm — #onAccept !job: an accept naming an unknown jobId is swallowed, never throws', () => {
	const { hub, jobs, sent, broadcasts } = harness();
	// No job enqueued at all → byId(GHOST) is undefined. Only `!job` can refuse this frame.
	expect(() => hub.handle({ type: 'job:accept', workerId: 'w1', jobId: GHOST })).not.toThrow();
	expect(jobs.byId(GHOST)).toBeNull(); // byId returns null for a missing row // no phantom row conjured
	expect(sent).toEqual([]); // no command emitted
	expect(broadcasts).toEqual([]); // no media:status broadcast
});

test('guard arm — #onReject !job: a reject naming an unknown jobId is swallowed, never throws', () => {
	const { hub, jobs, sent, broadcasts } = harness();
	expect(() => hub.handle({ type: 'job:reject', workerId: 'w1', jobId: GHOST, reason: 'busy' })).not.toThrow();
	expect(jobs.byId(GHOST)).toBeNull(); // byId returns null for a missing row
	expect(sent).toEqual([]); // no requeue → no redispatch command
	expect(broadcasts).toEqual([]);
});

test('guard arm — #onProgress !job: a progress frame naming an unknown jobId is swallowed, never throws', () => {
	const { hub, jobs, broadcasts } = harness();
	expect(() =>
		hub.handle({ type: 'job:progress', workerId: 'w1', jobId: GHOST, stage: 'separating', pct: 42 })
	).not.toThrow();
	expect(jobs.byId(GHOST)).toBeNull(); // byId returns null for a missing row
	expect(broadcasts).toEqual([]); // no progress rebroadcast for a job that does not exist
});

test('guard arm — #onComplete !job: a complete naming an unknown jobId is swallowed, never throws', () => {
	const { hub, jobs, mediaById, broadcasts, readied } = harness();
	expect(() =>
		hub.handle({
			type: 'job:complete',
			workerId: 'w1',
			jobId: GHOST,
			mediaUri: 'x',
			artifacts: { stems: { instrumental: 'derived/stems/GHOST-instrumental.flac' } }
		})
	).not.toThrow();
	expect(jobs.byId(GHOST)).toBeNull(); // byId returns null for a missing row
	// Nothing was published — the ghost frame names no media, so no song may flip to ready.
	expect(mediaById.get('m1')!.stemStatus).toBe('none');
	expect(mediaById.get('m1')!.instrumentalRef).toBeUndefined();
	expect(readied).toEqual([]); // onMediaReady never fired
	expect(broadcasts).toEqual([]);
});

test('guard arm — #onFailed !job: a failure frame naming an unknown jobId is swallowed, never throws', () => {
	const { hub, jobs, broadcasts } = harness();
	expect(() =>
		hub.handle({ type: 'job:failed', workerId: 'w1', jobId: GHOST, error: 'not a real job', retryable: false })
	).not.toThrow();
	expect(jobs.byId(GHOST)).toBeNull(); // byId returns null for a missing row
	expect(broadcasts).toEqual([]); // no failed broadcast for a nonexistent job
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

test('a full process records its timings, models and stage split on the attempt', () => {
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

test('a terminally failed stems job settles the media back to un-processed and says so', () => {
	// The phantom process: #onFailed used to leave stemStatus mid-flight, so isProcessing stayed true, the
	// phone row read "Making karaoke… 0%" forever and processState refused a retry. One worker OOM made
	// the song permanently unsingable with no way out but a DB edit.
	const { hub, jobs, mediaById, broadcasts } = harness();
	// enqueue alone does not touch the media; requestProcess is what marks it in flight, so set the
	// state that a real process would have left behind.
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
	// requestProcess marks the media processing BEFORE the download, so a dead fetch stranded it
	// exactly like a dead separation. This was the more likely of the two in practice: a missing deno
	// or a broken yt-dlp fails every fetch on the box.
	const { hub, jobs, mediaById } = harness();
	mediaById.set('m1', media('m1', { stemStatus: 'queued' }));
	const job = jobs.enqueue('m1', 'fetch', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['fetch:ytdlp'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	hub.handle({
		type: 'job:failed',
		workerId: 'w1',
		jobId: job.id,
		error: 'Requested format is not available',
		retryable: false
	});

	expect(mediaById.get('m1')!.stemStatus).toBe('none');
});

// ── FIX 3: a REFUSED stems-upgrade must change NOTHING on the song ────────────────────────────────
// markMediaReady refuses (returns false) an upgrade whose separator does not outrank the published
// one. The two artifact setters were called unconditionally regardless, and setMediaSongProfile
// normalizes an absent profile to EMPTY_SONG_PROFILE — so a refused upgrade WIPED the detected key
// and vocal range off a song that already had them. The fix guards both setters on the accept.
test('a refused stems-upgrade leaves the key, range, vocals and instrumental untouched', () => {
	const { hub, jobs, mediaById } = harness();
	// A song already processed at the TOP of the quality ladder (ensemble, rank 45), with a real key +
	// range profile and a guiding-vocals ref.
	const profile = {
		keyTonic: 3,
		keyMode: 'major',
		keyConfidence: 0.9,
		lowMidi: 50,
		highMidi: 72,
		p05Midi: 55,
		p95Midi: 67,
		histogram: [1, 2, 3]
	};
	mediaById.set(
		'm1',
		media('m1', {
			stemStatus: 'ready',
			instrumentalRef: 'derived/stems/m1-instrumental.flac',
			separator: { engine: 'ensemble', model: 'instrumental_clean' }, // rank 45
			vocalsRef: 'derived/stems/m1-vocals.flac',
			songProfile: profile as unknown as Media['songProfile']
		})
	);
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
			stems: {
				instrumental: 'derived/stems/m1-instrumental-UPGRADE.flac',
				vocals: 'derived/stems/m1-vocals-UPGRADE.flac'
			}
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
	mediaById.set(
		'm1',
		media('m1', {
			stemStatus: 'ready',
			instrumentalRef: 'derived/stems/m1-instrumental.flac',
			separator: { engine: 'demucs', model: 'htdemucs' } // rank 10
		})
	);
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
// resolveProcessSeparator was complete, tested, and had ZERO non-test callers: dispatch read
// global.defaultEngine/defaultModel directly, so a room set to a lower quality was ignored. The hub
// now folds resolveProcessSeparator over the effective settings before handing them to dispatch, which
// must lower BOTH the assigned engine/model AND the capability the stems job is routed by.

function hubWithSettings(getSettings: () => EffectiveSettings) {
	const db = migratedDb();
	const jobs = new JobRepository(db);
	const registry = new WorkerRegistry();
	const mediaById = new Map<string, Media>([['m1', media('m1')]]);
	const sent: { workerId: string; cmd: WorkerCommand }[] = [];
	const hub = new WorkerHub({
		jobs,
		registry,
		mediaById,
		toWorker: (workerId, cmd) => sent.push({ workerId, cmd }),
		broadcast: () => {},
		getSettings,
		now: () => T0
	});
	return { hub, jobs, sent };
}

const assignOf = (sent: { cmd: WorkerCommand }[]) =>
	sent.filter((s) => s.cmd.type === 'job:assign').map((s) => s.cmd)[0] as Extract<
		WorkerCommand,
		{ type: 'job:assign' }
	>;

test('a room quality ceiling LOWERS the stems engine, model, and routing capability', () => {
	// Global default is a high-tier roformer process; the room caps quality down to the demucs tier.
	const effective: EffectiveSettings = {
		global: { ...DEFAULT_EFFECTIVE_SETTINGS.global, defaultEngine: 'roformer', defaultModel: 'bs-roformer-1297' }, // rank 35
		room: { ...DEFAULT_EFFECTIVE_SETTINGS.room, maxQualityRank: 10 } // cap at the demucs:htdemucs tier
	};
	const { hub, jobs, sent } = hubWithSettings(() => effective);
	jobs.enqueue('m1', 'stems', 0, T0);
	// A demucs-only worker: it could NOT serve a roformer process, so the fact it gets the job proves the
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
	// The roformer worker is required now: an uncapped high-tier process must route to 'stems:roformer'.
	hub.handle({
		type: 'worker:hello',
		workerId: 'w-rof',
		capabilities: ['stems:roformer'],
		concurrency: 1,
		version: '1'
	});

	const assign = assignOf(sent);
	expect(assign).toBeTruthy();
	expect(assign.params.engine).toBe('roformer'); // global default preserved, never raised or altered
	expect(assign.params.model).toBe('bs-roformer-1297');
});

// ── an earlier change: an unservable process TTL-killed by dispatch() must settle its readiness gate ──
// The TTL branch in dispatch() moves a permanently-unservable job to terminal `failed`, but before
// an earlier change it left the media's gate mid-flight forever: readyToSing never flips, rotation holds the queue
// entry on every pass, and the song never plays even with its instrumental on disk. The existing
// 'unservable job past the TTL is failed' test asserts only job.status + broadcast — never the media.
// These assert the MEDIA state the issue names as the missing coverage.
test('TTL: a dead stems process settles the STEMS gate back to un-processed', () => {
	const { hub, jobs, mediaById, setClock } = harness();
	mediaById.set('m1', media('m1', { stemStatus: 'queued' })); // separation in flight
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	// A worker that can never serve stems... actually route by capability: connect an align-only
	// worker so the stems job is unservable.
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['align'], concurrency: 1, version: '1' });
	setClock(T0 + 1_000);
	hub.dispatch(); // first-seen unservable
	setClock(T0 + 121_000);
	hub.dispatch(); // past TTL → fail
	expect(jobs.byId(job.id)!.status).toBe('failed');
	// The regression: before an earlier change this stayed 'queued' forever.
	expect(mediaById.get('m1')!.stemStatus).toBe('none');
});

test('TTL: a dead align process settles the LYRICS gate on an already-playable song', () => {
	const { hub, jobs, mediaById, setClock } = harness();
	// Instrumental on disk, song plays; only the align follow-up is unservable.
	mediaById.set(
		'm1',
		media('m1', {
			stemStatus: 'ready',
			instrumentalRef: 'derived/stems/m1-instrumental.flac',
			lyricsStatus: 'queued'
		})
	);
	const job = jobs.enqueue('m1', 'align', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	setClock(T0 + 1_000);
	hub.dispatch();
	setClock(T0 + 121_000);
	hub.dispatch();
	expect(jobs.byId(job.id)!.status).toBe('failed');
	expect(mediaById.get('m1')!.lyricsStatus).toBe('ready'); // gate settled → the song can be sung
	expect(mediaById.get('m1')!.stemStatus).toBe('ready'); // playable instrumental untouched
});

test('a worker-reported release frees EXACTLY one slot — never double-frees via both machine and handler', () => {
	// Slot release now rides the machine (transition), so the handlers dropped their explicit
	// registry.releaseSlot() calls. A concurrency=2 worker holding TWO in-flight jobs makes a double
	// free observable that a concurrency=1 worker's Math.min clamp would hide: completing ONE job must
	// leave slotsFree at 1 (one slot back), not 2 (both, which a machine-release PLUS a re-added
	// handler-release would produce). Pins the release-removal hunks in #onComplete/#onReject.
	const { hub, jobs, registry, setClock } = harness();
	const a = jobs.enqueue('m1', 'stems', 0, T0);
	const b = jobs.enqueue('m2', 'stems', 1, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 2, version: '1' });
	// Both jobs dispatched to the two-slot worker.
	expect(registry.get('w1')!.slotsFree).toBe(0); // both slots claimed

	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: a.id });
	setClock(T0 + 1000);
	hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId: a.id,
		mediaUri: 'x',
		artifacts: { stems: { instrumental: 'derived/stems/m1-instrumental.flac' } }
	});
	expect(jobs.byId(a.id)!.status).toBe('ready');
	expect(registry.get('w1')!.slotsFree).toBe(1); // EXACTLY one freed — a double-free would read 2
	expect(jobs.byId(b.id)!.status).toBe('assigned'); // the other job still held by w1 (dispatched, not yet accepted)
});

test('job:reject frees EXACTLY one slot on a two-slot worker (no double-free via machine + handler)', () => {
	// Same double-free probe as the complete case, on the REJECT path (#onReject). On a concurrency=2
	// worker holding two assigned jobs, a reject of ONE must return slotsFree to 1 net — the rejected
	// job's slot back, then reclaimed by the redispatch of the SAME job to the still-free second slot.
	// A double-free (machine release + a re-added handler release) would over-count. Pins the
	// #onReject release-removal hunks (comment + dropped registry.releaseSlot).
	const { hub, jobs, registry } = harness();
	const a = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.enqueue('m2', 'stems', 1, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 2, version: '1' });
	expect(registry.get('w1')!.slotsFree).toBe(0); // both slots claimed

	hub.handle({ type: 'job:reject', workerId: 'w1', jobId: a.id, reason: 'busy' });
	// a released (→queued, slotsFree 1) then immediately redispatched to w1's free slot (→0 again).
	// The net is 0, NOT 1: a double-free on reject would leave slotsFree at 1 with a phantom slot.
	expect(registry.get('w1')!.slotsFree).toBe(0);
	expect(jobs.byId(a.id)!.status).toBe('assigned'); // redispatched, still owned by w1
});

test('a terminal job:failed frees EXACTLY one slot on a two-slot worker (no double-free)', () => {
	// The terminal (non-retryable) #onFailed branch releases through the machine (FAIL). On a
	// concurrency=2 worker holding two jobs, failing ONE non-retryably must leave slotsFree at 1, not
	// 2. Pins the #onFailed release-removal hunk (the explicit release dropped from the shared prologue).
	const { hub, jobs, registry, setClock } = harness();
	const a = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.enqueue('m2', 'stems', 1, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 2, version: '1' });
	expect(registry.get('w1')!.slotsFree).toBe(0);

	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: a.id });
	setClock(T0 + 1000);
	hub.handle({ type: 'job:failed', workerId: 'w1', jobId: a.id, error: 'source gone (404)', retryable: false });
	expect(jobs.byId(a.id)!.status).toBe('failed');
	expect(registry.get('w1')!.slotsFree).toBe(1); // EXACTLY one freed
});

// a lyrics mis-pick must be diagnosable from durable state, not just the process log. The worker
// carries the VariantChoice provenance on job:complete; the hub must persist it on the align attempt so
// /metrics/<mediaId> can later say WHICH candidate lost and whether a baseline even voted. On base the
// wire field is dropped end-to-end (no AttemptFacts.selection, no column, no attemptSelection), so the
// round-trip below reds: attemptSelection() returns null because nothing was stored.
test('persists the variant-pick provenance from job:complete so a mis-pick is diagnosable later', () => {
	const { hub, jobs, attempts } = harness();
	const job = jobs.enqueue('m1', 'align', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['align'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });

	const selection = {
		baselineFallback: false,
		winnerSuspect: false,
		winnerScore: 0.94,
		choices: [
			{
				textSource: 'lrclib',
				considered: 3,
				chosen: 'lrclib-synced',
				chosenScore: 0.94,
				decidedBy: 'agreement',
				votes: 2,
				// The rejected candidates + their scores — the evidence that existed for one log line and
				// is gone today. This is what separates arm (b) from arm (c) for a real mis-pick.
				rejected: [
					{ label: 'lrclib-plain', score: 0.61 },
					{ label: 'captions-stub', score: null }
				]
			}
		]
	};

	hub.handle({ type: 'job:complete', workerId: 'w1', jobId: job.id, mediaUri: 'derived/lyrics/m1.json', selection });

	// Retrievable from DURABLE state after the process — the whole point.
	const [a] = attempts.byMedia('m1');
	const got = attemptSelection(a);
	expect(got).not.toBeNull();
	expect(got!.winnerScore).toBe(0.94);
	expect(got!.choices).toHaveLength(1);
	const c = got!.choices[0];
	expect(c.chosen).toBe('lrclib-synced');
	expect(c.decidedBy).toBe('agreement'); // arm (b) vs (c): a baseline actually voted
	expect(c.votes).toBe(2); // how many baselines voted — 0 would mean the mean could not form
	// EVERY rejected label with its score survives to durable state, including the unjudgeable one.
	expect(c.rejected).toEqual([
		{ label: 'lrclib-plain', score: 0.61 },
		{ label: 'captions-stub', score: null }
	]);
});
