import { Media, ServerEvent } from '$lib/contract';
import { migratedDb } from '$lib/server/db/test-db';
import { AttemptLedger } from '$lib/server/jobs/attempts';
import { planAssignments } from '$lib/server/jobs/dispatch';
import { DEFAULT_LEASE_CONFIG, ackDeadline, progressDeadline } from '$lib/server/jobs/leases';
import { reportTerminalFailure, settleGatesForFailedJob } from '$lib/server/jobs/process';
import { JobReaper } from '$lib/server/jobs/reaper';
import { WorkerRegistry } from '$lib/server/jobs/registry';
import { JobRepository } from '$lib/server/jobs/repository';
import { expect, spyOn, test } from 'bun:test';

// A stalled job requeues; boot recovery clears in-flight. Drives the real JobRepository (in-memory sqlite) through the
// reaper with an injected clock — no wall-clock waits.

function setup(now: () => number, onReaped?: () => void) {
	const db = migratedDb();
	const jobs = new JobRepository(db);
	const reaper = new JobReaper(jobs, { now, onReaped, tickMs: 1_000_000 }); // tick only when we call it
	return { jobs, reaper };
}

const T0 = 1_700_000_000_000;

test('ack-timeout: an assigned job that never accepts requeues (no attempt burned)', () => {
	let clock = T0;
	const { jobs, reaper } = setup(() => clock);
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', ackDeadline(T0), T0); // 10s ack lease

	clock = T0 + 5_000; // still within ack window
	expect(reaper.tick()).toBe(0);
	expect(jobs.byId(job.id)!.status).toBe('assigned');

	clock = T0 + 11_000; // past the 10s ack deadline
	expect(reaper.tick()).toBe(1);
	const after = jobs.byId(job.id)!;
	expect(after.status).toBe('queued');
	expect(after.workerId).toBeNull();
	expect(after.leaseExpiresAt).toBeNull();
	expect(after.attempts).toBe(0); // worker never started → no attempt burned
});

test('progress-lease: a running job that stops heartbeating requeues with attempts++', () => {
	let clock = T0;
	const { jobs, reaper } = setup(() => clock);
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', ackDeadline(T0), T0);
	jobs.accept(job.id, progressDeadline(T0), T0 + 1); // 30s progress lease

	clock = T0 + 31_000; // missed the heartbeat window
	expect(reaper.tick()).toBe(1);
	const after = jobs.byId(job.id)!;
	expect(after.status).toBe('queued');
	expect(after.attempts).toBe(1);
	expect(after.workerId).toBeNull();
});

test('a heartbeat (progress) refreshes the lease so the reaper leaves it alone', () => {
	let clock = T0;
	const { jobs, reaper } = setup(() => clock);
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'w', ackDeadline(T0), T0);
	jobs.accept(job.id, progressDeadline(T0), T0 + 1);

	clock = T0 + 25_000;
	jobs.progress(job.id, { stage: 'separating', progressPct: 50, leaseExpiresAt: progressDeadline(clock) }, clock);
	clock = T0 + 31_000; // past the FIRST lease, but the heartbeat pushed it to T0+55s
	expect(reaper.tick()).toBe(0);
	expect(jobs.byId(job.id)!.status).toBe('running');
});

test('progress-lease exhaustion → terminal failed (not requeued forever)', () => {
	let clock = T0;
	const { jobs, reaper } = setup(() => clock);
	const job = jobs.enqueue('m1', 'stems', 0, T0);

	// Burn attempts to maxAttempts-1 via repeated assign→accept→lease-expiry.
	for (let i = 0; i < 2; i++) {
		jobs.assign(job.id, 'w', ackDeadline(clock), clock);
		jobs.accept(job.id, progressDeadline(clock), clock);
		clock += 31_000;
		reaper.tick();
		expect(jobs.byId(job.id)!.status).toBe('queued');
	}
	jobs.assign(job.id, 'w', ackDeadline(clock), clock);
	jobs.accept(job.id, progressDeadline(clock), clock);
	clock += 31_000;
	reaper.tick();
	const dead = jobs.byId(job.id)!;
	expect(dead.status).toBe('failed');
	expect(dead.attempts).toBe(3);
	expect(dead.error).toContain('attempts exhausted');
});

test('boot recovery resets every assigned/running job to queued (attempts preserved)', () => {
	const { jobs, reaper } = setup(() => T0 + 100);
	const a = jobs.enqueue('m1', 'stems', 0, T0); // will be assigned
	const r = jobs.enqueue('m2', 'stems', 0, T0); // will be running (attempts=2)
	const q = jobs.enqueue('m3', 'stems', 0, T0); // already queued — untouched
	jobs.assign(a.id, 'worker-A', ackDeadline(T0), T0);
	jobs.assign(r.id, 'worker-B', ackDeadline(T0), T0);
	jobs.accept(r.id, progressDeadline(T0), T0);
	jobs.requeue(r.id, 2, T0); // simulate prior retries so attempts=2
	jobs.assign(r.id, 'worker-B', ackDeadline(T0), T0);
	jobs.accept(r.id, progressDeadline(T0), T0);

	const recovered = reaper.recoverOnBoot();
	expect(recovered).toBe(2); // a + r, not q
	expect(jobs.byId(a.id)!.status).toBe('queued');
	expect(jobs.byId(a.id)!.workerId).toBeNull();
	expect(jobs.byId(r.id)!.status).toBe('queued');
	expect(jobs.byId(r.id)!.attempts).toBe(2); // a core restart isn't the worker's fault
	expect(jobs.byId(q.id)!.status).toBe('queued');
});

test('onReaped fires once per tick that changed ≥1 job, and not on a no-op', () => {
	let clock = T0;
	let calls = 0;
	const { jobs, reaper } = setup(
		() => clock,
		() => calls++
	);
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'w', ackDeadline(T0), T0);

	reaper.tick(); // within window — no change
	expect(calls).toBe(0);
	clock = T0 + 11_000;
	reaper.tick(); // ack-timeout requeue
	expect(calls).toBe(1);
});

// A reaper-killed process must settle its readiness gate. When the worker box dies mid-process the
// failure reaches terminal `failed` through the reaper's attempts-exhaustion path and NEVER through
// #onFailed, so a gate left mid-flight never flips readyToSing and rotation holds the queue entry on
// every pass, even with the instrumental on disk. The reaper has no catalog, so app.ts wires its
// onFailed hook to settleGatesForFailedJob — driven live here, never reimplemented.

const mkMedia = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'none',
	...over
});

function exhaustToFailed(jobType: 'stems' | 'align', over: Partial<Media> = {}) {
	let clock = T0;
	const db = migratedDb();
	const jobs = new JobRepository(db);
	const mediaById = new Map<string, Media>([['m1', mkMedia('m1', over)]]);
	const reaper = new JobReaper(jobs, {
		now: () => clock,
		tickMs: 1_000_000,
		onFailed: (job) => settleGatesForFailedJob(job, mediaById)
	});
	const job = jobs.enqueue('m1', jobType, 0, T0);
	for (let i = 0; i < 3; i++) {
		jobs.assign(job.id, 'w', ackDeadline(clock), clock);
		jobs.accept(job.id, progressDeadline(clock), clock);
		clock += 31_000;
		reaper.tick();
	}
	return { jobs, mediaById, job };
}

test('reaper: a dead stems process settles the STEMS gate back to un-processed', () => {
	// Separation in flight, then the box dies and the reaper exhausts attempts.
	const { jobs, mediaById, job } = exhaustToFailed('stems', { stemStatus: 'queued' });
	expect(jobs.byId(job.id)!.status).toBe('failed'); // reaper path, not #onFailed
	// Left 'queued', isProcessing stays true and rotation holds the entry forever.
	expect(mediaById.get('m1')!.stemStatus).toBe('none');
});

test('reaper: a dead align process settles the LYRICS gate so the playable song can be sung', () => {
	// The song already plays; only lyrics were pending, so it is align that dies.
	const { jobs, mediaById, job } = exhaustToFailed('align', {
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		lyricsStatus: 'queued'
	});
	expect(jobs.byId(job.id)!.status).toBe('failed');
	expect(mediaById.get('m1')!.lyricsStatus).toBe('ready'); // gate settled → readyToSing can flip
	expect(mediaById.get('m1')!.stemStatus).toBe('ready'); // never walk the finished process backwards
});

// A reaper-killed process must be REPORTED, not silent: every terminal-fail path runs the SAME epilogue
// — settle the gate, broadcast media:status failed, log one operator line, reclaim the scratch. Settling
// the gate alone leaves the watching phone pinned on "Making karaoke… N%" with no Sing button forever.
//
// Drives a REAL JobReaper + JobRepository to attempts-exhaustion with the PRODUCTION
// `reportTerminalFailure` as the onFailed hook — the same function app.ts and both worker-hub paths
// call — so a site that diverges from it can no longer pass. Reconstructing the hook inline here would
// make this a fourth copy of the epilogue rather than a test of it.

const T0_ReaperBroadcastOnFailure = 1_700_000_000_000;

const mkMedia_ReaperBroadcastOnFailure = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'none',
	...over
});

function exhaust(jobType: 'stems' | 'align' | 'stems-upgrade', over: Partial<Media> = {}) {
	let clock = T0_ReaperBroadcastOnFailure;
	const db = migratedDb();
	const jobs = new JobRepository(db);
	const mediaById = new Map<string, Media>([['m1', mkMedia_ReaperBroadcastOnFailure('m1', over)]]);
	const broadcasts: ServerEvent[] = [];
	// The REAL production epilogue as the onFailed hook, exactly as app.ts wires it, over an injected
	// broadcast sink. cleanJobWork is a no-op here (no scratch for these ids) and the log line goes
	// through console.warn, which each test spies.
	const reaper = new JobReaper(jobs, {
		now: () => clock,
		tickMs: 1_000_000,
		onFailed: (job) => reportTerminalFailure(job, 'reaper', { broadcast: (e) => broadcasts.push(e), mediaById })
	});
	const job = jobs.enqueue('m1', jobType, 0, T0_ReaperBroadcastOnFailure);
	for (let i = 0; i < 3; i++) {
		jobs.assign(job.id, 'w', ackDeadline(clock), clock);
		jobs.accept(job.id, progressDeadline(clock), clock);
		clock += 31_000;
		reaper.tick();
	}
	return { jobs, mediaById, job, broadcasts };
}

test('reaper-killed stems process broadcasts media:status failed + logs uniformly (the room is told)', () => {
	const warn = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		const { jobs, job, broadcasts } = exhaust('stems', { stemStatus: 'queued' });
		expect(jobs.byId(job.id)!.status).toBe('failed');
		// Exactly one media:status failed reaches the sink.
		const statusEvents = broadcasts.filter((e) => e.type === 'media:status');
		expect(statusEvents.length).toBe(1);
		const ev = statusEvents[0] as Extract<ServerEvent, { type: 'media:status' }>;
		expect(ev.status).toBe('failed');
		expect(ev.mediaId).toBe('m1');
		// Exactly one operator line, in the uniform key=value format, naming the reaper cause.
		expect(warn).toHaveBeenCalledTimes(1);
		const line = warn.mock.calls[0]![0] as string;
		expect(line).toContain('cause=reaper');
		expect(line).toContain(`job=${job.id}`);
		expect(line).toContain('media=m1');
		expect(line).toContain('attempts=');
		expect(line).toContain('reason=');
	} finally {
		warn.mockRestore();
	}
});

test('reaper-killed align process (playable song) still broadcasts failed', () => {
	const warn = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		// align dies on an already-playable song: the lyrics gate settles, and the room still hears failed.
		const { broadcasts } = exhaust('align', {
			stemStatus: 'ready',
			instrumentalRef: 'derived/stems/m1-instrumental.flac',
			lyricsStatus: 'queued'
		});
		const statusEvents = broadcasts.filter((e) => e.type === 'media:status');
		expect(statusEvents.length).toBe(1);
		expect((statusEvents[0] as Extract<ServerEvent, { type: 'media:status' }>).status).toBe('failed');
	} finally {
		warn.mockRestore();
	}
});

test('a dead stems-upgrade on an ALREADY-singable song is NOT broadcast (no ready-row regress)', () => {
	const warn = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		// shouldBroadcastProcess returns false for a stems-upgrade on a readyToSing song — broadcasting failed
		// would flip a happy ready row back to a failure chip for a background job the singer never saw.
		const { jobs, job, broadcasts } = exhaust('stems-upgrade', {
			stemStatus: 'ready',
			instrumentalRef: 'derived/stems/m1-instrumental.flac',
			lyricsStatus: 'ready'
		});
		expect(jobs.byId(job.id)!.status).toBe('failed');
		expect(broadcasts.filter((e) => e.type === 'media:status').length).toBe(0);
		// Even a suppressed broadcast still logs the terminal failure — the operator record is unconditional.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]![0] as string).toContain('cause=reaper');
	} finally {
		warn.mockRestore();
	}
});

// The job machine read slot release off the EVENT NAME alone, so the reaper's terminal
// FAIL (a presumed-DEAD worker whose progress lease lapsed with attempts exhausted) freed the slot
// of a worker that was STILL holding a live job, driving an assign/reject storm.
//
// FAIL reaches `JobRepository.transition` from three callers and only ONE is a worker report:
//   • worker-hub `#onFailed` terminal branch — worker-reported, workerId set → SHOULD release
//   • worker-hub unservable-TTL branch        — job still `queued`, workerId null → cannot release
//   • reaper `tick()` exhausted-attempts       — presumed-dead worker, workerId still set → MUST NOT release
// The machine treated all three the same because it keyed off the event name. The fix removes FAIL
// from SLOT_RELEASING_EVENTS and releases explicitly at the one worker-report call site; the reaper's
// dead-worker fail then frees nothing (the registry reclaims that slot on the next heartbeat).
//
// These tests wire the real JobReaper against a real JobRepository + WorkerRegistry with the hub's
// own release hook (`setSlotReleaseHook`), exactly as worker-hub.ts:167 wires it in production, and
// assert the reaper's FAIL does not disturb a live worker's slot. RED on base: the reaper's fail()
// fires the machine's release hook, so slotsFree goes 0 → 1 and planAssignments lands a job on the still-busy worker.

const T0_ReaperFailNotSlotRelease = 1_700_000_000_000;

/**
 * Real machine wired the way app.ts wires it: the repository's slot-release hook drives the
 * registry, so a release event visibly moves the owning worker's slotsFree.
 */
function fleet() {
	const db = migratedDb();
	const ledger = new AttemptLedger(db);
	const jobs = new JobRepository(db, ledger);
	const registry = new WorkerRegistry();
	// Production wiring (worker-hub.ts): a machine release event frees the owning worker's slot.
	jobs.setSlotReleaseHook((wid) => registry.releaseSlot(wid));
	return { jobs, registry };
}

// A worker w1 at concurrency 2 holding two jobs: `a` with a DEAD progress lease and attempts one
// short of exhaustion, `b` still running with a live lease. slotsFree is 0 (both slots claimed).
function busyWorkerHoldingDeadAndLive(jobs: JobRepository, registry: WorkerRegistry) {
	registry.hello('w1', ['stems'], 2, 'test', T0_ReaperFailNotSlotRelease);
	const a = jobs.enqueue('mA', 'stems', 0, T0_ReaperFailNotSlotRelease);
	const b = jobs.enqueue('mB', 'stems', 0, T0_ReaperFailNotSlotRelease);
	// a: dispatched, accepted, then progressed twice so attempts == 2 (next reap exhausts 3/3)
	jobs.assign(a.id, 'w1', null, T0_ReaperFailNotSlotRelease + 1);
	registry.claimSlot('w1');
	jobs.accept(a.id, progressDeadline(T0_ReaperFailNotSlotRelease + 1), T0_ReaperFailNotSlotRelease + 2);
	jobs.requeue(a.id, 1, T0_ReaperFailNotSlotRelease + 3, 'LEASE_EXPIRED'); // burn one attempt without releasing (reaper path)
	jobs.assign(a.id, 'w1', null, T0_ReaperFailNotSlotRelease + 4);
	jobs.accept(a.id, progressDeadline(T0_ReaperFailNotSlotRelease + 4), T0_ReaperFailNotSlotRelease + 5);
	jobs.progress(
		a.id,
		{ attempts: 2, leaseExpiresAt: T0_ReaperFailNotSlotRelease + 5 },
		T0_ReaperFailNotSlotRelease + 5
	); // attempts=2, lease will be dead by trigger time
	// b: dispatched + accepted, live lease well into the future
	jobs.assign(b.id, 'w1', null, T0_ReaperFailNotSlotRelease + 6);
	registry.claimSlot('w1');
	jobs.accept(b.id, progressDeadline(T0_ReaperFailNotSlotRelease + 1_000_000), T0_ReaperFailNotSlotRelease + 7);
	return { a, b };
}

test("the reaper terminal FAIL does NOT free a live worker's slot", () => {
	const { jobs, registry } = fleet();
	const { a } = busyWorkerHoldingDeadAndLive(jobs, registry);
	expect(registry.get('w1')!.slotsFree).toBe(0); // both slots occupied

	// TRIGGER: a's lease is dead and its next attempt (3) is exhausting → reaper fails it.
	const trigger = T0_ReaperFailNotSlotRelease + 5 + DEFAULT_LEASE_CONFIG.progressLeaseMs + 1;
	const reaper = new JobReaper(jobs, { now: () => trigger, tickMs: 1_000_000 });
	reaper.tick();

	expect(jobs.byId(a.id)!.status).toBe('failed'); // the job still goes terminal — we did NOT skip fail()
	expect(registry.get('w1')!.slotsFree).toBe(0); // RED ON BASE: base frees it (0 → 1) — a live worker is at 2/2
});

test('no phantom assignment lands on the still-busy worker after a reaper FAIL', () => {
	const { jobs, registry } = fleet();
	busyWorkerHoldingDeadAndLive(jobs, registry);
	// A third song is waiting in the queue.
	jobs.enqueue('mC', 'stems', 0, T0_ReaperFailNotSlotRelease + 8);

	const trigger = T0_ReaperFailNotSlotRelease + 5 + DEFAULT_LEASE_CONFIG.progressLeaseMs + 1;
	new JobReaper(jobs, { now: () => trigger, tickMs: 1_000_000 }).tick();

	const queued = jobs.listByStatus('queued');
	const plan = planAssignments(queued, registry.list(), () => 'stems');
	// RED ON BASE: base over-freed a slot, so the plan hands mC to w1 while w1 is truly at 2/2 —
	// the worker's own capacity gate rejects it, requeue re-dispatches, and the storm begins.
	expect(plan).toEqual([]);
});
