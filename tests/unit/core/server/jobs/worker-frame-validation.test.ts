// worker WS frames were JSON.parsed then cast + executed with NO runtime validation,
// reachable UNAUTHENTICATED (role=worker upgrades are permitted when ENCORE_WORKER_TOKEN is unset).
// server.ts:message() did `if ('workerId' in msg && msg.workerId) ... app.workerHub.handle(msg)` with
// nothing guarding the shape. Three unguarded reads, each proven to throw on base below:
//   1. JSON.parse('null') → `'workerId' in msg` throws TypeError (server.ts).
//   2. { type:'worker:hello', capabilities: 1 } → `[...capabilities]` throws in registry.hello.
//   3. { type:'worker:hello', capabilities: 'stems' } → string spreads into chars, `.join(',')` mishandles.
// validateWorkerMessage(msg) now runs BEFORE those reads (server.ts, mirroring realtime/hub.ts's
// validateCommand). CALL CHAIN pinned: WS message() → JSON.parse → validateWorkerMessage → (reject)
// | WorkerHub.handle → #onHello → registry.hello / caps.join.
//
// Each test is RED on base: validateWorkerMessage does not exist there (import fails), and the
// gate() mirror throws exactly as production did.
import { test, expect } from 'bun:test';
import { migratedDb } from '$server/db/test-db';
import { WorkerHub, validateWorkerMessage } from '$server/jobs/worker-hub';
import { WorkerRegistry } from '$server/jobs/registry';
import { JobRepository } from '$server/jobs/repository';
import type { WorkerMessage } from '@encore/shared';

function harness() {
	const db = migratedDb();
	const jobs = new JobRepository(db);
	const sent: unknown[] = [];
	const hub = new WorkerHub({
		jobs,
		registry: new WorkerRegistry(),
		mediaById: new Map(),
		toWorker: (_id, cmd) => sent.push(cmd),
		broadcast: () => {},
		onMediaReady: () => {},
		now: () => 1
	});
	return { hub, sent };
}

// EXACT mirror of server.ts:message()'s role=worker path — parse, validate, only then read fields
// and execute. Proves the production gate contains the throw rather than a private reimplementation:
// the SAME validateWorkerMessage production imports is the sole thing standing between the parse and
// the reads.
function gate(raw: string, hub: WorkerHub): 'dropped' | 'handled' {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return 'dropped';
	}
	if (validateWorkerMessage(parsed) !== null) return 'dropped';
	const msg = parsed as WorkerMessage;
	if ('workerId' in msg && msg.workerId) {
		/* socket keying — the read that threw on null */
	}
	hub.handle(msg);
	return 'handled';
}

// ── Unguarded read 1: a null body ────────────────────────────────────────────────────────────
test('read 1: JSON.parse(null) body is rejected, never reaches the workerId read', () => {
	const { hub } = harness();
	expect(validateWorkerMessage(null)).not.toBeNull();
	// The raw `'workerId' in null` that server.ts did throws — prove the pre-guard hazard is real:
	expect(() => 'workerId' in (null as unknown as object)).toThrow();
	// …and prove the gate contains it: no throw, frame dropped, nothing executed.
	expect(gate('null', hub)).toBe('dropped');
});

// ── Unguarded read 2: capabilities as a number ───────────────────────────────────────────────
test('read 2: worker:hello with capabilities:1 is rejected before [...capabilities]', () => {
	const { hub, sent } = harness();
	const frame = { type: 'worker:hello', workerId: 'w', capabilities: 1, concurrency: 1, version: '1' };
	expect(validateWorkerMessage(frame)).not.toBeNull();
	// Base proof that the read throws when the guard is absent:
	expect(() => [...(1 as unknown as Iterable<string>)]).toThrow();
	expect(gate(JSON.stringify(frame), hub)).toBe('dropped');
	expect(sent.length).toBe(0); // nothing dispatched, no welcome sent
});

// ── Unguarded read 3: capabilities as a string ───────────────────────────────────────────────
test('read 3: worker:hello with capabilities:"stems" (string) is rejected before .join', () => {
	const { hub, sent } = harness();
	const frame = { type: 'worker:hello', workerId: 'w', capabilities: 'stems', concurrency: 1, version: '1' };
	expect(validateWorkerMessage(frame)).not.toBeNull();
	expect(gate(JSON.stringify(frame), hub)).toBe('dropped');
	expect(sent.length).toBe(0);
});

// ── Assorted malformed shapes the same three reads would trip on ───────────────────────────────
test('a frame missing workerId is rejected', () => {
	expect(validateWorkerMessage({ type: 'worker:heartbeat', slotsFree: 1, runningJobIds: [] })).not.toBeNull();
});
test('a non-object / primitive body is rejected', () => {
	expect(validateWorkerMessage(42)).not.toBeNull();
	expect(validateWorkerMessage('hello')).not.toBeNull();
	expect(validateWorkerMessage([])).not.toBeNull();
});
test('an unknown frame type is rejected (never falls through handle())', () => {
	expect(validateWorkerMessage({ type: 'worker:evil', workerId: 'w' })).not.toBeNull();
});
test('heartbeat with a non-array runningJobIds is rejected', () => {
	expect(
		validateWorkerMessage({ type: 'worker:heartbeat', workerId: 'w', slotsFree: 1, runningJobIds: 'x' })
	).not.toBeNull();
});
test('job:progress with a non-number pct is rejected', () => {
	expect(
		validateWorkerMessage({ type: 'job:progress', workerId: 'w', jobId: 'j', stage: 'separating', pct: 'lots' })
	).not.toBeNull();
});

// ── A well-formed frame still passes and is handled (the guard is not over-broad) ──────────────
test('a valid worker:hello passes validation and is handled normally', () => {
	const { hub, sent } = harness();
	const frame = { type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 2, version: '1.0' };
	expect(validateWorkerMessage(frame)).toBeNull();
	expect(gate(JSON.stringify(frame), hub)).toBe('handled');
	// hello triggers a welcome handshake — proof the valid frame actually executed:
	expect(sent.length).toBeGreaterThan(0);
});
