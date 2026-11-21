// A fake worker socket drives a job to `ready`; also the welcome handshake, dispatch-on-hello,
// progress→media:status rebroadcast, reject/requeue, retryable vs terminal failure, and need-ordered dispatch. No real
// socket — sinks capture the effects.
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { WorkerHub, validateWorkerMessage } from '$lib/server/jobs/worker-hub';
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

// ── worker:catalogue — the models a worker reports it can run ────────────────────────────────────

test('a catalogue frame replaces capabilities and records the offers', () => {
	const { hub, registry } = harness();
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({
		type: 'worker:catalogue',
		workerId: 'w1',
		capabilities: ['stems', 'stems:audiosep', 'stems:model:a-model'],
		separators: [{ token: 'a-model', label: 'A Model', architecture: 'MDXC' }]
	});
	const w = registry.get('w1')!;
	expect(w.capabilities).toContain('stems:model:a-model');
	expect(w.separators!.map((o) => o.token)).toEqual(['a-model']);
});

test('a catalogue REPLACES rather than merges, so a withdrawn model stops being routable', () => {
	// The worker sends its full set for exactly this reason. Merging would keep a model a worker has since
	// stopped offering — an extra uninstalled, a version downgraded — and core would route a job to a box
	// that now refuses it.
	const { hub, registry } = harness();
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	const frame = (tokens: string[]) => ({
		type: 'worker:catalogue' as const,
		workerId: 'w1',
		capabilities: ['stems', ...tokens.map((t) => `stems:model:${t}`)],
		separators: tokens.map((t) => ({ token: t, label: t, architecture: 'MDXC' }))
	});
	hub.handle(frame(['gone', 'kept']));
	hub.handle(frame(['kept']));
	const w = registry.get('w1')!;
	expect(w.capabilities).not.toContain('stems:model:gone');
	expect(w.separators!.map((o) => o.token)).toEqual(['kept']);
});

test('a catalogue for an unregistered worker is ignored, not used to resurrect it', () => {
	// Arriving after a close is stale. Inventing a session from it would bring back a worker the reaper has
	// already written off, with slots core would then dispatch into.
	const { hub, registry } = harness();
	hub.handle({
		type: 'worker:catalogue',
		workerId: 'ghost',
		capabilities: ['stems'],
		separators: [{ token: 'a-model', label: 'A', architecture: 'MDXC' }]
	});
	expect(registry.get('ghost')).toBeNull();
});

test('a catalogue does not disturb slotsFree', () => {
	// It says nothing about load, and resetting it here would discard the dispatcher's view seconds after a
	// reconnect had already rebuilt it.
	const { hub, jobs, registry } = harness();
	jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 2, version: '1' });
	const before = registry.get('w1')!.slotsFree;
	hub.handle({ type: 'worker:catalogue', workerId: 'w1', capabilities: ['stems'], separators: [] });
	expect(registry.get('w1')!.slotsFree).toBe(before);
});

test('a catalogue dispatches, because a job may have been unservable waiting for it', () => {
	// `hasCapableWorker` is false for `stems:model:<token>` until this frame lands. Without the dispatch the
	// job would sit queued until the next unrelated event.
	const { hub, jobs, sent } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: [], concurrency: 1, version: '1' });
	expect(cmdsOfType(sent, 'job:assign')).toHaveLength(0); // nothing it can serve yet
	hub.handle({
		type: 'worker:catalogue',
		workerId: 'w1',
		capabilities: ['stems'],
		separators: [{ token: 'a-model', label: 'A', architecture: 'MDXC' }]
	});
	const assigns = cmdsOfType(sent, 'job:assign') as Array<Extract<WorkerCommand, { type: 'job:assign' }>>;
	expect(assigns.map((a) => a.jobId)).toEqual([job.id]);
});

test('capability summarising collapses the per-model tokens', () => {
	// A zoo worker advertises ~137 tokens, 135 of them `stems:model:*`. Printed verbatim that is a 6 KB log
	// line that buries the two or three tokens anyone reads a join message for.
	const many = ['align', 'stems', ...Array.from({ length: 135 }, (_, i) => `stems:model:m${i}`)];
	const summary = WorkerHub.summariseCapabilities(many);
	expect(summary).toBe('align,stems,+135 models');
	expect(summary.length).toBeLessThan(60);
});

test('capability summarising leaves a worker without models exactly as it was', () => {
	expect(WorkerHub.summariseCapabilities(['align', 'stems'])).toBe('align,stems');
	expect(WorkerHub.summariseCapabilities([])).toBe('none');
});

test('validateWorkerMessage refuses a catalogue whose offers carry no token', () => {
	// The token is what a job names and what lands in `job_attempts.model`. A blank one is unroutable.
	expect(
		validateWorkerMessage({ type: 'worker:catalogue', workerId: 'w1', capabilities: [], separators: [{ label: 'x' }] })
	).toBe('malformed separators');
	expect(
		validateWorkerMessage({ type: 'worker:catalogue', workerId: 'w1', capabilities: [], separators: [{ token: '' }] })
	).toBe('malformed separators');
	expect(
		validateWorkerMessage({
			type: 'worker:catalogue',
			workerId: 'w1',
			capabilities: ['stems'],
			separators: [{ token: 'ok', label: 'Ok', architecture: 'MDXC' }]
		})
	).toBeNull();
});

test('hello → welcome handshake + dispatch of a waiting job', () => {
	const { hub, jobs, sent } = harness();
	jobs.enqueue('m1', 'stems', 0, T0); // a job is already waiting

	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });

	const welcome = cmdsOfType(sent, 'worker:welcome')[0] as Extract<WorkerCommand, { type: 'worker:welcome' }>;
	// heartbeatIntervalSec is HALF the 30s progress lease, so a worker honouring it has room for one dropped tick before
	// breaching. The derived-value invariant is pinned in vocabulary-parity.test.ts.
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
	// sourceRef stays the ORIGIN, so search still recognises the song as already processed.
	const m = mediaById.get('m1')!;
	expect(m.stemStatus).toBe('ready');
	expect(m.instrumentalRef).toBe('derived/stems/m1-instrumental.flac');
	expect(m.sourceRef).toBe('vid-m1');
	// The SONG is not ready: separation finished but the words are not timed, and the align job this completion enqueued
	// is what the room waits on. A completed job of ANY type mapping to 'ready' is the defect — a live 'ready' overrides
	// the catalog, so every phone calls a song singable whose instrumental does not exist yet.
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

	hub.handle({ type: 'job:accept', workerId: 'w-evil', jobId: job.id });
	expect(jobs.byId(job.id)!.status).toBe('assigned');
	hub.handle({ type: 'job:progress', workerId: 'w1', jobId: job.id, stage: 'separating', pct: 10 });
	expect(jobs.byId(job.id)!.progressPct).toBe(0);
});

// ONE TEST PER WORKER-FRAME GUARD ARM. Every handler shares the same stale-frame guard:
//   if (!job || job.status !== '<expected>' || job.workerId !== msg.workerId) return;
// Each test reaches a state where the NAMED arm is the sole defence, so deleting exactly that arm reds exactly that
// test. Keep that property when editing one.

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
	// Without the status arm, accept() would re-stamp a fresh progress lease on every duplicate.
	h.setClock(T0 + 50_000);
	h.hub.handle({ type: 'job:accept', workerId: 'w1', jobId });
	expect(h.jobs.byId(jobId)!.status).toBe('running');
	expect(h.jobs.byId(jobId)!.leaseExpiresAt).toBe(leaseAfterFirst); // lease NOT refreshed
});

test('guard arm — #onReject workerId: a reject from the wrong worker is ignored (job stays assigned)', () => {
	const { hub, jobs } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:reject', workerId: 'w-evil', jobId: job.id, reason: 'busy' });
	expect(jobs.byId(job.id)!.status).toBe('assigned'); // NOT requeued by the impostor
});

test('guard arm — #onReject status: a reject after the job is running is ignored (no requeue)', () => {
	const h = harness();
	const jobId = running(h); // status 'running', workerId 'w1' — workerId matches the reject
	// Refusing a reject once running is what stops a mid-run requeue and a double-freed slot.
	h.hub.handle({ type: 'job:reject', workerId: 'w1', jobId, reason: 'changed my mind' });
	expect(h.jobs.byId(jobId)!.status).toBe('running'); // still running, not walked back to queued
});

test('guard arm — #onProgress workerId: a progress frame from the wrong worker is ignored', () => {
	const h = harness();
	const jobId = running(h); // status 'running' (matches the progress guard), workerId 'w1'
	h.hub.handle({ type: 'job:progress', workerId: 'w-evil', jobId, stage: 'separating', pct: 77 });
	expect(h.jobs.byId(jobId)!.progressPct).toBe(0); // impostor's progress not applied
});

test('guard arm — #onComplete workerId: a ZOMBIE worker cannot publish over the live owner', () => {
	const h = harness();
	const { hub, jobs, mediaById, registry } = h;
	// The reaper-requeue end state, modelled directly: running and OWNED BY w2, with w1 still alive.
	const jobId = running(h, 'w1'); // running, workerId 'w1'
	jobs.requeue(jobId, jobs.byId(jobId)!.attempts, T0 + 1_000); // reaper requeues the (still-live) job
	hub.handle({ type: 'worker:hello', workerId: 'w2', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w2', jobId }); // w2 now owns it
	expect(jobs.byId(jobId)!.workerId).toBe('w2');
	const w1SlotsBefore = registry.get('w1')!.slotsFree;
	// Weakened, the zombie's instrumental is published PERMANENTLY and w2's real completion is dropped silently, because
	// the status is already 'ready'.
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
	// jobs.complete() would attempt assigned→ready, an illegal transition whose throw escapes the message handler and
	// ends the socket. The guard must swallow it.
	expect(() => hub.handle({ type: 'job:complete', workerId: 'w1', jobId: job.id, mediaUri: 'x' })).not.toThrow();
	expect(jobs.byId(job.id)!.status).toBe('assigned'); // untouched
	expect(mediaById.get('m1')!.stemStatus).toBe('none'); // nothing published
});

test('guard arm — #onFailed workerId: a failure frame from the wrong worker is ignored', () => {
	const h = harness();
	const jobId = running(h); // running, workerId 'w1'
	const attemptsBefore = h.jobs.byId(jobId)!.attempts;
	h.hub.handle({ type: 'job:failed', workerId: 'w-evil', jobId, error: 'not mine to fail', retryable: false });
	expect(h.jobs.byId(jobId)!.status).toBe('running'); // still running
	expect(h.jobs.byId(jobId)!.attempts).toBe(attemptsBefore); // no attempt burned by the impostor
});

test('guard arm — #onFailed status: a failure while still assigned (not running) is ignored', () => {
	const { hub, jobs } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	// A failure before the job ever ran must not burn an attempt or move it off 'assigned'.
	hub.handle({ type: 'job:failed', workerId: 'w1', jobId: job.id, error: 'premature', retryable: false });
	expect(jobs.byId(job.id)!.status).toBe('assigned');
	expect(jobs.byId(job.id)!.attempts).toBe(0);
});

// The `!job` arm: a frame naming a jobId with NO row must be swallowed, never thrown. Without it `job.status`
// dereferences undefined and the TypeError escapes the message handler (whose only try/catch wraps the JSON.parse) and
// ENDS the worker socket — one malformed frame killing a party. Each test fires a well-formed frame with a jobId that
// was never enqueued, so `!job` is the sole defence: there is no row for the other two arms to read.

// A jobId no repository row will ever match.
const GHOST = 'ghost-job-does-not-exist';

test('guard arm — #onAccept !job: an accept naming an unknown jobId is swallowed, never throws', () => {
	const { hub, jobs, sent, broadcasts } = harness();
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

test('job:reject → back to queued (no attempt burned), worker held until its heartbeat, then redispatched', () => {
	const { hub, jobs, registry, sent } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	expect(registry.get('w1')!.slotsFree).toBe(0); // claimed on dispatch
	// The heartbeat a worker sends after hello, landing after the dispatch it raced.
	hub.handle({ type: 'worker:heartbeat', workerId: 'w1', slotsFree: 0, runningJobIds: [] });

	hub.handle({ type: 'job:reject', workerId: 'w1', jobId: job.id, reason: 'busy' });
	const after = jobs.byId(job.id)!;
	expect(after.attempts).toBe(0); // never ran
	expect(after.status).toBe('queued'); // NOT straight back to the worker that just refused it
	expect(registry.get('w1')!.slotsFree).toBe(0); // held
	expect(cmdsOfType(sent, 'job:assign')).toHaveLength(1);

	// The worker's own count lifts the hold; the next dispatch (the reaper ticks every 3 s) uses it.
	hub.handle({ type: 'worker:heartbeat', workerId: 'w1', slotsFree: 1, runningJobIds: [] });
	hub.dispatch();
	expect(jobs.byId(job.id)!.status).toBe('assigned');
	expect(cmdsOfType(sent, 'job:assign')).toHaveLength(2); // initial + redispatch
});

test('a FULL worker that rejects after a reconnect is not re-offered the job at network speed', () => {
	// hello resets slotsFree to concurrency, so a worker reconnecting mid-job is offered a second job it must refuse.
	// Releasing the slot on that reject handed the same job straight back, 50 times in a row, for the rest of the run.
	const { hub, jobs, sent } = harness();
	const running = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: running.id });
	const waiting = jobs.enqueue('m2', 'stems', 1, T0);

	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({ type: 'worker:heartbeat', workerId: 'w1', slotsFree: 0, runningJobIds: [running.id] });
	const offers = () => cmdsOfType(sent, 'job:assign').filter((c) => c.type === 'job:assign' && c.jobId === waiting.id);
	expect(offers()).toHaveLength(1);
	for (let i = 0; i < 5; i++) {
		hub.handle({ type: 'job:reject', workerId: 'w1', jobId: waiting.id, reason: 'no free slots' });
		hub.handle({ type: 'worker:heartbeat', workerId: 'w1', slotsFree: 0, runningJobIds: [running.id] });
		hub.dispatch();
	}
	expect(offers()).toHaveLength(1);
	expect(jobs.byId(waiting.id)!.status).toBe('queued');
});

test('job:failed retryable with attempts left → requeue + redispatch; exhausted → failed', () => {
	const { hub, jobs, setClock } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });

	// 3 attempts (maxAttempts default 3): the first two requeue and are immediately redispatched to the now-free worker,
	// so status returns to 'assigned'; the third exhausts to terminal failed.
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

// An unservable job must not park queued FOREVER: one whose capability no connected worker advertises never reaches a
// terminal state, so the TV and phones wait indefinitely. After UNSERVABLE_TTL_MS (~120s) it moves to `failed` via
// jobs.fail, so #emitStatus broadcasts it.
test('an unservable job past the TTL is failed and broadcasts failed', () => {
	const { hub, jobs, broadcasts, setClock } = harness();
	const job = jobs.enqueue('m1', 'align', 0, T0); // needs align capability
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	expect(jobs.byId(job.id)!.status).toBe('queued');

	setClock(T0 + 119_000);
	hub.dispatch();
	expect(jobs.byId(job.id)!.status).toBe('queued');

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
	hub.handle({ type: 'worker:hello', workerId: 'w-stems', capabilities: ['stems'], concurrency: 1, version: '1' });
	expect(jobs.byId(job.id)!.status).toBe('queued');

	setClock(T0 + 30_000);
	hub.handle({ type: 'worker:hello', workerId: 'w-align', capabilities: ['align'], concurrency: 1, version: '1' });
	expect(jobs.byId(job.id)!.status).toBe('assigned');

	// Far past when the TTL would have fired, the now-assigned job is untouched: the unservable tracking is pruned the
	// moment it finds a worker, so a later stall cannot retroactively fail it.
	setClock(T0 + 200_000);
	hub.dispatch();
	expect(jobs.byId(job.id)!.status).toBe('assigned');
});

// The attempt ledger over the real wire path: dispatch writes what was ASKED, job:complete overwrites it with what
// actually RAN, and the row is sealed with its timings.

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
	expect(attemptStages(a)).toEqual([
		{ stage: 'downloading', ms: 9_000 },
		{ stage: 'separating', ms: 81_000 }
	]);
	// media durationSec is 200 here: 90s of compute for 200s of audio.
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
		facts: { engine: 'roformer', model: 'mel-band-roformer', device: 'cpu' }
	});

	const [a] = attempts.byMedia('m1');
	expect(a.model).toBe('mel-band-roformer');
	expect(a.device).toBe('cpu');
});

test('an older worker that reports no facts still gets a sealed, timed attempt', () => {
	// The wire fields are additive: an older worker sends neither, and the attempt must still carry the timings the CORE
	// measured rather than being left open forever.
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
	// #onFailed MUST settle stemStatus. Left mid-flight, isProcessing stays true, the phone row reads "Making karaoke…
	// 0%" forever and processState refuses a retry: one worker OOM makes the song permanently unsingable.
	const { hub, jobs, mediaById, broadcasts } = harness();
	// enqueue alone does not touch the media — requestProcess is what marks it in flight.
	mediaById.set('m1', media('m1', { stemStatus: 'queued' }));
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	expect(mediaById.get('m1')!.stemStatus).toBe('queued'); // in flight

	hub.handle({ type: 'job:failed', workerId: 'w1', jobId: job.id, error: 'CUDA OOM', retryable: false });

	expect(jobs.byId(job.id)!.status).toBe('failed');
	expect(mediaById.get('m1')!.stemStatus).toBe('none'); // settled — retryable again
	const statuses = broadcasts.filter((e) => e.type === 'media:status');
	expect(statuses.at(-1)).toMatchObject({ type: 'media:status', mediaId: 'm1', status: 'failed' });
	// The failure carries the settled row, so a phone that never fetched the song can name it.
	expect((statuses.at(-1) as Extract<ServerEvent, { type: 'media:status' }>).media).toEqual(mediaById.get('m1')!);
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
	// requestProcess marks the media processing BEFORE the download, so a dead fetch strands it exactly like a dead
	// separation — and a missing deno or a broken yt-dlp fails every fetch on the box.
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

// A REFUSED stems-upgrade must change NOTHING. markMediaReady returns false for an upgrade whose separator does not
// outrank the published one, and both artifact setters are guarded on that accept: setMediaSongProfile normalizes an
// absent profile to EMPTY_SONG_PROFILE, so calling it anyway wipes the detected key and vocal range.
test('a refused stems-upgrade leaves the key, range, vocals and instrumental untouched', () => {
	const { hub, jobs, mediaById } = harness();
	// Already processed at the TOP of the ladder, with a real profile and guide ref.
	//
	// This used to be `ensemble:instrumental_clean` (rank 45). That engine has been REMOVED from the registry
	// — it advertised `stems:ensemble`, which no worker ever implemented — so it now ranks 0 and any candidate
	// would outrank it, inverting this test. bs-roformer-1297 (35) is the highest remaining rung, and the
	// default upgrade target resolves to the same pairing: equal rank is not STRICTLY better, so it is
	// refused, which is the behaviour under test.
	//
	// No real row can carry the old value: the capability was never implemented, so no worker ever produced
	// an ensemble separation to record.
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
			separator: { engine: 'roformer', model: 'bs-roformer-1297' }, // rank 35, the top of the ladder
			vocalsRef: 'derived/stems/m1-vocals.flac',
			songProfile: profile as unknown as Media['songProfile']
		})
	);
	// With no settings the upgrade resolves to roformer:bs-roformer-1297 (rank 35) — the SAME pairing already
	// published, which does not strictly outrank itself, so markMediaReady refuses it.
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
			// No songProfile on this frame — the condition that normalizes to EMPTY and wipes the
		}
	});

	const m = mediaById.get('m1')!;
	expect(m.instrumentalRef).toBe('derived/stems/m1-instrumental.flac'); // NOT the UPGRADE key
	expect(m.vocalsRef).toBe('derived/stems/m1-vocals.flac'); // NOT the UPGRADE vocals
	expect(m.songProfile).toEqual(profile as unknown as Media['songProfile']); // key + range preserved
	expect(m.separator).toEqual({ engine: 'roformer', model: 'bs-roformer-1297' }); // unchanged by the refusal
});

test('an ACCEPTED stems-upgrade DOES swap the artifacts (the guard is not over-eager)', () => {
	const { hub, jobs, mediaById } = harness();
	// Published at the BOTTOM (demucs htdemucs, rank 10), so the default roformer upgrade outranks it and is accepted.
	mediaById.set(
		'm1',
		media('m1', {
			stemStatus: 'ready',
			instrumentalRef: 'derived/stems/m1-instrumental.flac',
			separator: { engine: 'demucs', model: 'htdemucs' } // rank 10
		})
	);
	const job = jobs.enqueue('m1', 'stems-upgrade', 0, T0);
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

// The room's downward-only quality ceiling must reach dispatch: the hub folds resolveProcessSeparator over the
// effective settings first, and that must lower BOTH the assigned engine/model AND the capability the job is routed by.
// Reading global.defaultEngine directly ignores the room.

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
	const effective: EffectiveSettings = {
		global: { ...DEFAULT_EFFECTIVE_SETTINGS.global, defaultEngine: 'roformer', defaultModel: 'bs-roformer-1297' }, // rank 35
		room: { ...DEFAULT_EFFECTIVE_SETTINGS.room, maxQualityRank: 10 } // cap at the demucs:htdemucs tier
	};
	const { hub, jobs, sent } = hubWithSettings(() => effective);
	jobs.enqueue('m1', 'stems', 0, T0);
	// A demucs-only worker could NOT serve a roformer process, so it getting the job proves the capability was lowered to
	// 'stems' (demucs), not left at 'stems:roformer'.
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

// An unservable process TTL-killed by dispatch() must ALSO settle the media's readiness gate: left mid-flight,
// readyToSing never flips, rotation holds the entry on every pass, and the song never plays even with its instrumental
// on disk. The TTL test above asserts only job.status and the broadcast, so these assert the MEDIA state.
test('TTL: a dead stems process settles the STEMS gate back to un-processed', () => {
	const { hub, jobs, mediaById, setClock } = harness();
	mediaById.set('m1', media('m1', { stemStatus: 'queued' })); // separation in flight
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	// An align-only worker, so the stems job is unservable by capability.
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['align'], concurrency: 1, version: '1' });
	setClock(T0 + 1_000);
	hub.dispatch(); // first-seen unservable
	setClock(T0 + 121_000);
	hub.dispatch(); // past TTL → fail
	expect(jobs.byId(job.id)!.status).toBe('failed');
	// This is the arm that stays 'queued' forever if the gate is not settled.
	expect(mediaById.get('m1')!.stemStatus).toBe('none');
});

test('TTL: a dead align process settles the LYRICS gate on an already-playable song', () => {
	const { hub, jobs, mediaById, setClock } = harness();
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
	// Slot release rides the machine transition, so no handler may also call registry.releaseSlot(). Concurrency=2 is
	// what makes a double free OBSERVABLE (a concurrency=1 worker's Math.min clamp hides it), so completing one of two
	// in-flight jobs must leave slotsFree at 1, never 2.
	const { hub, jobs, registry, setClock } = harness();
	const a = jobs.enqueue('m1', 'stems', 0, T0);
	const b = jobs.enqueue('m2', 'stems', 1, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 2, version: '1' });
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
	// The same double-free probe on the REJECT path: the rejected job's slot comes back, then the redispatch of that SAME
	// job reclaims the still-free second slot, so the net is 1.
	const { hub, jobs, registry } = harness();
	const a = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.enqueue('m2', 'stems', 1, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 2, version: '1' });
	expect(registry.get('w1')!.slotsFree).toBe(0); // both slots claimed

	hub.handle({ type: 'job:reject', workerId: 'w1', jobId: a.id, reason: 'busy' });
	// Net 0, not 1: a double-free on reject would leave slotsFree at 1 with a phantom slot.
	expect(registry.get('w1')!.slotsFree).toBe(0);
	expect(jobs.byId(a.id)!.status).toBe('assigned'); // redispatched, still owned by w1
});

test('a HELD two-slot worker gets back exactly the slot its heartbeat reports (no phantom slot)', () => {
	// The heartbeated variant of the test above: the hold zeroes the count, and the worker's own report restores it.
	const { hub, jobs, registry } = harness();
	const a = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.enqueue('m2', 'stems', 1, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 2, version: '1' });
	expect(registry.get('w1')!.slotsFree).toBe(0); // both slots claimed
	hub.handle({ type: 'worker:heartbeat', workerId: 'w1', slotsFree: 0, runningJobIds: [] });

	hub.handle({ type: 'job:reject', workerId: 'w1', jobId: a.id, reason: 'busy' });
	expect(registry.get('w1')!.slotsFree).toBe(0); // held until the worker reports
	expect(jobs.byId(a.id)!.status).toBe('queued');

	// The worker reports its one real free slot; the redispatch takes exactly it. A phantom slot would read 1.
	hub.handle({ type: 'worker:heartbeat', workerId: 'w1', slotsFree: 1, runningJobIds: [] });
	hub.dispatch();
	expect(registry.get('w1')!.slotsFree).toBe(0);
	expect(jobs.byId(a.id)!.status).toBe('assigned'); // redispatched, still owned by w1
});

test('a worker that has never heartbeated is not held on reject, since nothing would lift the hold', () => {
	// An older worker sends no heartbeat at all: it keeps the slot-release behaviour rather than starving.
	const { hub, jobs, registry } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:reject', workerId: 'w1', jobId: job.id, reason: 'busy' });
	expect(jobs.byId(job.id)!.status).toBe('assigned'); // released and redispatched, as before
	expect(registry.get('w1')!.slotsFree).toBe(0);
});

test('an align that reports a refused publish as a retryable job:failed is requeued, not settled as no lyrics', () => {
	// The frame the worker now sends when its lyrics publish is refused. A job:complete there settled the lyrics gate
	// as "align ran and found nothing" for a job nobody finished.
	const { hub, jobs, mediaById } = harness();
	const job = jobs.enqueue('m1', 'align', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['align'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	hub.handle({
		type: 'job:failed',
		workerId: 'w1',
		jobId: job.id,
		error: 'abandoned before publishing: revoked',
		retryable: true
	});
	const after = jobs.byId(job.id)!;
	expect(after.status).not.toBe('ready');
	expect(after.attempts).toBe(1);
	expect(mediaById.get('m1')!.lyricsStatus).not.toBe('ready');
});

test('a fetch that reports a refused publish as a retryable job:failed is requeued and chains no stems job', () => {
	// The frame the worker now sends when its fetch publish is refused. A job:complete there marked the fetch done and
	// queued stems, the follow-up core chains on every fetch completion, for audio nobody published.
	const { hub, jobs } = harness();
	const job = jobs.enqueue('m1', 'fetch', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['fetch:ytdlp'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	expect(jobs.byId(job.id)!.status).toBe('running');
	hub.handle({
		type: 'job:failed',
		workerId: 'w1',
		jobId: job.id,
		error: 'abandoned before publishing: revoked',
		retryable: true
	});
	const after = jobs.byId(job.id)!;
	expect(after.status).not.toBe('ready');
	expect(after.attempts).toBe(1);
	expect(jobs.listByStatus('queued').some((j) => j.jobType === 'stems')).toBe(false);
});

test('a stems completion that names no instrumental is a retryable failure, not a ready song', () => {
	// The frame a worker sent when its publish was refused: `mediaUri: ""` and no artifacts. Readying it derived a key
	// for a file nobody wrote and queued align, so the TV 404'd on a "ready" song.
	const { hub, jobs, mediaById } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	hub.handle({ type: 'job:complete', workerId: 'w1', jobId: job.id, mediaUri: '' });

	const after = jobs.byId(job.id)!;
	expect(after.status).not.toBe('ready');
	expect(after.attempts).toBe(1); // requeued as a failed attempt
	const m = mediaById.get('m1')!;
	expect(m.stemStatus).not.toBe('ready');
	expect(m.instrumentalRef).toBeUndefined();
	expect(jobs.listByStatus('queued').some((j) => j.jobType === 'align')).toBe(false); // no follow-up
});

test('a terminal job:failed frees EXACTLY one slot on a two-slot worker (no double-free)', () => {
	// The same probe on the terminal #onFailed branch, which releases through the machine's FAIL.
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

// A lyrics mis-pick must be diagnosable from DURABLE state, not only the process log: the worker carries VariantChoice
// provenance on job:complete and the hub persists it on the align attempt, so /metrics/<mediaId> can say which
// candidate lost and whether a baseline even voted.
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
				// The rejected candidates and their scores: what tells a wrong-pick apart from a no-candidates run.
				rejected: [
					{ label: 'lrclib-plain', score: 0.61 },
					{ label: 'captions-stub', score: null }
				]
			}
		]
	};

	hub.handle({ type: 'job:complete', workerId: 'w1', jobId: job.id, mediaUri: 'derived/lyrics/m1.json', selection });

	const [a] = attempts.byMedia('m1');
	const got = attemptSelection(a);
	expect(got).not.toBeNull();
	expect(got!.winnerScore).toBe(0.94);
	expect(got!.choices).toHaveLength(1);
	const c = got!.choices[0];
	expect(c.chosen).toBe('lrclib-synced');
	expect(c.decidedBy).toBe('agreement'); // arm (b) vs (c): a baseline actually voted
	expect(c.votes).toBe(2); // how many baselines voted — 0 would mean the mean could not form
	// EVERY rejected label with its score survives, including the unjudgeable one.
	expect(c.rejected).toEqual([
		{ label: 'lrclib-plain', score: 0.61 },
		{ label: 'captions-stub', score: null }
	]);
});
