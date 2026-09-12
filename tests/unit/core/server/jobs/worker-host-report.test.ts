// The two seams this file covers were both WRITTEN AND NEVER WIRED before: the worker's hardware was
// computed and printed only to its own stdout, and `hasCapableWorker` was exported plus unit-tested
// with zero production call sites. So these tests are about the wiring, not the pure functions —
// the failure mode they guard is "the capability exists but nothing calls it".
import { test, expect } from 'bun:test';
import { migratedDb } from '$server/db/test-db';
import { WorkerHub } from '$server/jobs/worker-hub';
import { WorkerRegistry } from '$server/jobs/registry';
import { JobRepository } from '$server/jobs/repository';
import type { WorkerCommand, ServerEvent, Media, WorkerHost } from '$shared';

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

const HOST: WorkerHost = {
	accelerator: 'cuda',
	cuda: true,
	deviceName: 'NVIDIA GeForce RTX 3080',
	deviceCount: 1,
	cpuCount: 8,
	memoryBytes: 32 * 1024 ** 3,
	vramBytes: 10 * 1024 ** 3,
	platform: 'Linux',
	machine: 'x86_64',
	python: '3.12.3',
	torch: '2.8.0+cu128',
	contained: false
};

function harness(mediaOver: Record<string, Partial<Media>> = {}) {
	const db = migratedDb();
	const jobs = new JobRepository(db);
	const registry = new WorkerRegistry();
	const mediaById = new Map<string, Media>([
		['m1', media('m1', mediaOver.m1 ?? {})],
		['m2', media('m2', mediaOver.m2 ?? {})]
	]);
	const sent: { workerId: string; cmd: WorkerCommand }[] = [];
	const broadcasts: ServerEvent[] = [];
	const hub = new WorkerHub({
		jobs,
		registry,
		mediaById,
		toWorker: (workerId, cmd) => sent.push({ workerId, cmd }),
		broadcast: (e) => broadcasts.push(e),
		now: () => T0
	});
	return { hub, jobs, registry, mediaById, sent, broadcasts };
}

const statuses = (broadcasts: ServerEvent[]) =>
	broadcasts.filter((b) => b.type === 'media:status') as Extract<ServerEvent, { type: 'media:status' }>[];

// ── S5: the worker's hardware reaches the core ──────────────────────────────────────
test('a reported host is stored on the session, so the core can stop guessing at hardware', () => {
	const { hub, registry } = harness();
	hub.handle({
		type: 'worker:hello',
		workerId: 'w1',
		capabilities: ['stems'],
		concurrency: 1,
		version: '1',
		host: HOST
	});
	// estimateCookSeconds takes a hardwareFactor that nothing ever supplied — this is the value that
	// makes it real, so it has to survive the handshake rather than being logged and dropped.
	expect(registry.get('w1')!.host).toEqual(HOST);
});

test('a worker that reports NO host still registers (the field is additive, not required)', () => {
	// An older worker must keep working: the core simply treats its hardware as unknown, exactly as it
	// did before the field existed.
	const { hub, registry } = harness();
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	expect(registry.get('w1')).toBeTruthy();
	expect(registry.get('w1')!.host).toBeUndefined();
});

test('a reconnect REPLACES the reported hardware rather than keeping the stale reading', () => {
	// A worker can move: same id, different box (or the same box with a GPU newly passed through). The
	// registry already replaces capabilities on reconnect; hardware must follow the same rule or the
	// core plans against a machine that no longer exists.
	const { hub, registry } = harness();
	hub.handle({
		type: 'worker:hello',
		workerId: 'w1',
		capabilities: ['stems'],
		concurrency: 1,
		version: '1',
		host: HOST
	});
	hub.handle({
		type: 'worker:hello',
		workerId: 'w1',
		capabilities: ['stems'],
		concurrency: 1,
		version: '1',
		host: { ...HOST, accelerator: 'cpu', deviceName: '', vramBytes: null }
	});
	expect(registry.get('w1')!.host!.accelerator).toBe('cpu');
	expect(registry.get('w1')!.host!.vramBytes).toBeNull();
});

// ── S6: an unservable job is loud ───────────────────────────────────────────────────
test('a job no connected worker can run is announced as unservable, not silently parked', () => {
	// THE failure this fixes: "no worker advertises this capability" and "every worker is busy" both
	// leave the job queued, and the operator cannot tell them apart — so a song stuck at 0% forever
	// reads as a hung worker, and the process gets restarted instead of the fleet getting fixed.
	const { hub, jobs, broadcasts } = harness();
	jobs.enqueue('m1', 'align', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });

	const unservable = statuses(broadcasts).filter((s) => s.unservable);
	expect(unservable.length).toBe(1);
	expect(unservable[0].mediaId).toBe('m1');
});

test('an unservable job is reported ONCE, not on every dispatch pass', () => {
	// dispatch() runs after every event that could free capacity, so an un-deduped warning would fill
	// the log and bury the one line that matters.
	const { hub, jobs, broadcasts } = harness();
	jobs.enqueue('m1', 'align', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.dispatch();
	hub.dispatch();
	expect(statuses(broadcasts).filter((s) => s.unservable).length).toBe(1);
});

test('a job waiting only for a FREE SLOT is never called unservable', () => {
	// The distinction is the entire point: this job's capability is covered, it just has to wait, and
	// telling the room it is stuck forever would be a lie.
	const { hub, jobs, broadcasts } = harness();
	jobs.enqueue('m1', 'stems', 0, T0);
	jobs.enqueue('m2', 'stems', 1, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });

	expect(statuses(broadcasts).some((s) => s.unservable)).toBe(false);
});

test('a stalled follow-up does NOT regress an already-playable song to cooking', () => {
	// A published song with a stalled `align` follow-up is genuinely unservable — and irrelevant to the
	// room, because the song plays. Broadcasting a queued status for it would flip a ready song back to
	// cooking on every phone, which is a worse bug than the one being reported: missing lyrics is not
	// missing audio.
	const { hub, jobs, broadcasts } = harness({
		m1: { instrumentalRef: 'derived/stems/m1-instrumental.flac', stemStatus: 'ready' }
	});
	jobs.enqueue('m1', 'align', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });

	expect(statuses(broadcasts).some((s) => s.unservable)).toBe(false);
});

test('once a capable worker joins, the job dispatches and the stall is forgotten', () => {
	// The unservable mark must not be sticky: a fleet gains workers at runtime (that is the whole point
	// of dial-home), and a job marked stuck must un-stick without a core restart.
	const { hub, jobs, sent, broadcasts } = harness();
	jobs.enqueue('m1', 'align', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	expect(statuses(broadcasts).filter((s) => s.unservable).length).toBe(1);

	hub.handle({ type: 'worker:hello', workerId: 'w2', capabilities: ['align'], concurrency: 1, version: '1' });
	const assigns = sent.filter((s) => s.cmd.type === 'job:assign');
	expect(assigns.length).toBe(1);
	expect(assigns[0].workerId).toBe('w2');
});

test('with no workers at all, a queued job is still reported as unservable', () => {
	// The empty-fleet case is the most common one in practice — the worker container was never started,
	// or crash-looped on a missing dependency. It has to name the gap rather than look like a queue.
	const { hub, jobs, broadcasts } = harness();
	jobs.enqueue('m1', 'stems', 0, T0);
	hub.dispatch();
	expect(statuses(broadcasts).filter((s) => s.unservable).length).toBe(1);
});
