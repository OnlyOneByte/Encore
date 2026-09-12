/*
 * guard: the boot reconciliation of stale readiness gates is actually WIRED, and wired where it works.
 *
 * The behavioural arms live in tests/unit/core/server/jobs/gate-reconcile-boot.test.ts and drive
 * `reconcileStrandedGates` directly. They stay green if app.ts never calls it — which is the whole
 * defect class this fix belongs to: XR-JOB-04's first half was a settle that worked in memory and was
 * never persisted, and the sibling XR-JOB-11 was a TTL whose check was never reached because nothing
 * called the function that held it. A repair nobody invokes is indistinguishable from no repair.
 *
 * Three things are pinned, each because getting it wrong would silently un-fix the bug:
 *
 *   1. The call exists, with BOTH deps. `findLiveJob` is what stops it clobbering a live process;
 *      `persist` is what makes the settle survive to the next boot. Either omitted is a type error
 *      today, but the shape is what a future edit would erode.
 *   2. It runs AFTER hydrateMediaCatalog. The pass reads the runtime map; before the hydrate the map is
 *      empty, so the call would be a green no-op that repairs nothing.
 *   3. It runs SYNCHRONOUSLY at boot, not from the detached boot-maintenance chain. The chain is for
 *      passes boot must not wait on (directory scans); moving this one in there would leave a stranded
 *      song observable — served to the first phone that loads the library — for as long as the passes
 *      ahead of it take, which is the failure the pass exists to prevent.
 */

import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const APP = read('src/lib/server/app.ts');

// Not-vacuous sentinel: a broken or empty read must red HERE rather than making every scan below pass.
test('app.ts reads as the boot module it is', () => {
	expect(APP.length).toBeGreaterThan(5_000);
	expect(APP).toContain('hydrateMediaCatalog(mediaRepo.all(), mediaById)');
});

test('app.ts imports the boot gate reconciliation', () => {
	expect(APP).toMatch(/import\s*\{[^}]*\breconcileStrandedGates\b[^}]*\}\s*from\s*'\.\/jobs\/gate-reconcile'/);
});

test('the call passes BOTH the ledger lookup and the persistence sink', () => {
	// ONE anchored match over the whole call rather than three substring scans: `mediaRepo.upsert` and
	// `jobs.findLive` both appear elsewhere in app.ts, so unanchored scans would stay green with the
	// deps swapped for something that always reports "nothing is live" (settling every processing song)
	// or with the sink dropped (settling in memory only — the original bug).
	expect(APP).toMatch(
		/reconcileStrandedGates\(\s*mediaById,\s*\{\s*findLiveJob:\s*\(mediaId,\s*jobType\)\s*=>\s*jobs\.findLive\(mediaId,\s*jobType\),\s*persist:\s*\(m\)\s*=>\s*mediaRepo\.upsert\(m\)\s*\}\s*\)/
	);
});

test('the reconciliation runs after the hydrate that reads the stale value', () => {
	const hydrate = APP.indexOf('hydrateMediaCatalog(mediaRepo.all(), mediaById)');
	const reconcile = APP.indexOf('reconcileStrandedGates(mediaById');
	expect(hydrate).toBeGreaterThanOrEqual(0);
	expect(reconcile).toBeGreaterThan(hydrate);
});

test('the reconciliation is synchronous boot work, not a detached boot-maintenance pass', () => {
	// The pass must complete before the first request can observe a stranded row, so it may not be
	// awaited-later work: it sits ahead of the bootTasks table and is not one of its entries.
	const reconcile = APP.indexOf('reconcileStrandedGates(mediaById');
	const bootTasks = APP.indexOf('const bootTasks: BootTask[]');
	expect(reconcile).toBeGreaterThanOrEqual(0);
	expect(bootTasks).toBeGreaterThan(reconcile);
	// …and it is not itself deferred behind an await/then/queue inside its own statement.
	const stmt = APP.slice(reconcile - 200, reconcile);
	expect(stmt).not.toMatch(/await\s+$|\.then\(\s*$|setTimeout\(|queueMicrotask\(/);
});

test('a failed reconciliation cannot stop the party server booting', () => {
	// Same rule migrateStorageLayout already follows: housekeeping must never be fatal at boot. Without
	// the guard a hand-edited row or a genuine bug in the pass takes the whole box down.
	const reconcile = APP.indexOf('reconcileStrandedGates(mediaById');
	const tryIdx = APP.lastIndexOf('try {', reconcile);
	expect(tryIdx).toBeGreaterThanOrEqual(0);
	const after = APP.slice(reconcile);
	const catchIdx = after.indexOf('} catch');
	expect(catchIdx).toBeGreaterThanOrEqual(0);
	expect(after.slice(catchIdx, catchIdx + 400)).toMatch(/readiness-gate reconciliation skipped/);
});

/*
 * ── ONE settlement rule, two readers ───────────────────────────────────────────────────────────────
 *
 * The two halves of XR-JOB-04 answer the same question from opposite ends — "this job just died, which
 * gate does it settle" and "no job can ever settle this gate, so settle it now" — and a second copy of
 * the per-type mapping is precisely how they would drift. A future step added to one list and not the
 * other reintroduces the worst failure in this subsystem (a song reading as processing forever) in the
 * half nobody edited, silently. `GATE_SETTLEMENT` is the single table; these arms pin that BOTH readers
 * still read it rather than restating it.
 */
const PROCESS = read('src/lib/server/jobs/process.ts');
const RECONCILE = read('src/lib/server/jobs/gate-reconcile.ts');

test('the per-gate settlement rule is declared once, as a table', () => {
	expect(PROCESS).toMatch(/export const GATE_SETTLEMENT: readonly GateSettlement\[\]/);
	// Both gates present with their settling job types — the mapping itself, so a deleted entry reds.
	expect(PROCESS).toMatch(/id: 'stems',[\s\S]{0,400}?settledBy: \['fetch', 'stems'\]/);
	expect(PROCESS).toMatch(/id: 'lyrics',[\s\S]{0,400}?settledBy: \['align'\]/);
});

test('settleGatesForFailedJob reads the table instead of restating the rule', () => {
	const sig = PROCESS.indexOf('export function settleGatesForFailedJob');
	expect(sig).toBeGreaterThanOrEqual(0);
	const body = PROCESS.slice(sig, PROCESS.indexOf('\n}', sig));
	expect(body).toMatch(/GATE_SETTLEMENT\.find\(\(g\) => g\.settledBy\.includes\(job\.jobType\)\)/);
	// The restated form is what this guard exists to forbid: a per-type `if` chain here is a second copy
	// of the mapping, and it is the shape the code had before the boot pass gained a second reader.
	expect(body).not.toMatch(/job\.jobType === '(align|fetch|stems)'/);
});

test('the boot reconciliation reads the same table, and settles through the same function', () => {
	expect(RECONCILE).toMatch(/import \{ GATE_SETTLEMENT \} from '\.\/process'/);
	// It must iterate the table (so a new gate is covered for free) and settle through the table's own
	// `settle`, which is the same function reference settleGatesForFailedJob invokes.
	expect(RECONCILE).toMatch(/for \(const gate of GATE_SETTLEMENT\)/);
	expect(RECONCILE).toMatch(/gate\.settle\(media\.id, mediaById\)/);
	expect(RECONCILE).toMatch(/gate\.settledBy\.some\(/);
	// …and must never name a job type or a gate column itself. Either would be the second copy.
	expect(RECONCILE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(
		/'(align|fetch|stems|stems-upgrade)'|stemStatus|lyricsStatus/
	);
});
