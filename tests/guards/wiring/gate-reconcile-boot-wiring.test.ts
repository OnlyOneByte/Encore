/*
 * guard: the boot reconciliation of stale readiness gates is WIRED, and wired where it works — the
 * behavioural arms drive `reconcileStrandedGates` directly and stay green if app.ts never calls it. BOTH
 * deps must be passed (`findLiveJob` stops it clobbering a live process, `persist` makes the settle survive
 * the next boot); it must run AFTER hydrateMediaCatalog, which fills the map it reads; and SYNCHRONOUSLY at
 * boot, or a stranded song stays observable to the first phone that loads the library.
 */

import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const APP = read('src/lib/server/app.ts');

// A broken, moved or emptied read must red HERE rather than making every scan below pass. Anchored on
// SYMBOLS, never on byte length: a length floor makes deleting a comment fail a test.
test('app.ts reads as the boot module it is', () => {
	expect(APP).toContain('hydrateMediaCatalog(mediaRepo.all(), mediaById)');
	expect(APP).toMatch(/const bootTasks: BootTask\[\]/);
});

test('app.ts imports the boot gate reconciliation', () => {
	expect(APP).toMatch(/import\s*\{[^}]*\breconcileStrandedGates\b[^}]*\}\s*from\s*'\.\/jobs\/gate-reconcile'/);
});

test('the call passes BOTH the ledger lookup and the persistence sink', () => {
	// ONE anchored match, not three substring scans: `mediaRepo.upsert` and `jobs.findLive` appear
	// elsewhere in app.ts, so unanchored scans stay green with a dep swapped for something that always
	// reports "nothing is live" (settling every processing song) or with the sink dropped entirely.
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
	// It must sit ahead of the bootTasks table and not be one of its entries.
	const reconcile = APP.indexOf('reconcileStrandedGates(mediaById');
	const bootTasks = APP.indexOf('const bootTasks: BootTask[]');
	expect(reconcile).toBeGreaterThanOrEqual(0);
	expect(bootTasks).toBeGreaterThan(reconcile);
	// …nor be deferred behind an await/then/queue inside its own statement.
	const stmt = APP.slice(reconcile - 200, reconcile);
	expect(stmt).not.toMatch(/await\s+$|\.then\(\s*$|setTimeout\(|queueMicrotask\(/);
});

test('a failed reconciliation cannot stop the party server booting', () => {
	// Housekeeping must never be fatal at boot: unguarded, a hand-edited row takes the whole box down.
	const reconcile = APP.indexOf('reconcileStrandedGates(mediaById');
	const tryIdx = APP.lastIndexOf('try {', reconcile);
	expect(tryIdx).toBeGreaterThanOrEqual(0);
	const after = APP.slice(reconcile);
	const catchIdx = after.indexOf('} catch');
	expect(catchIdx).toBeGreaterThanOrEqual(0);
	expect(after.slice(catchIdx, catchIdx + 400)).toMatch(/readiness-gate reconciliation skipped/i);
});

// ONE settlement rule, two readers. Two halves ask it from opposite ends — "this job died, which gate
// does it settle" and "no job can settle this gate, so settle it now" — so a second copy of the per-type
// mapping drifts when a new step is added to one list only, leaving a song reading as processing forever
// in the half nobody edited. `GATE_SETTLEMENT` is the single table.
const PROCESS = read('src/lib/server/jobs/process.ts');
const RECONCILE = read('src/lib/server/jobs/gate-reconcile.ts');

test('the per-gate settlement rule is declared once, as a table', () => {
	expect(PROCESS).toMatch(/export const GATE_SETTLEMENT: readonly GateSettlement\[\]/);
	// The mapping itself, so a deleted entry reds rather than quietly stranding its gate.
	expect(PROCESS).toMatch(/id: 'stems',[\s\S]{0,400}?settledBy: \['fetch', 'stems'\]/);
	expect(PROCESS).toMatch(/id: 'lyrics',[\s\S]{0,400}?settledBy: \['align'\]/);
});

test('settleGatesForFailedJob reads the table instead of restating the rule', () => {
	const sig = PROCESS.indexOf('export function settleGatesForFailedJob');
	expect(sig).toBeGreaterThanOrEqual(0);
	const body = PROCESS.slice(sig, PROCESS.indexOf('\n}', sig));
	expect(body).toMatch(/GATE_SETTLEMENT\.find\(\(g\) => g\.settledBy\.includes\(job\.jobType\)\)/);
	// A per-type `if` chain here is the second copy of the mapping, and is the shape the code had before.
	expect(body).not.toMatch(/job\.jobType === '(align|fetch|stems)'/);
});

test('the boot reconciliation reads the same table, and settles through the same function', () => {
	expect(RECONCILE).toMatch(/import \{ GATE_SETTLEMENT \} from '\.\/process'/);
	// Iterating the table covers a new gate for free, and `gate.settle` is the same function reference
	// `settleGatesForFailedJob` invokes.
	expect(RECONCILE).toMatch(/for \(const gate of GATE_SETTLEMENT\)/);
	expect(RECONCILE).toMatch(/gate\.settle\(media\.id, mediaById\)/);
	expect(RECONCILE).toMatch(/gate\.settledBy\.some\(/);
	// Naming a job type or a gate column here would be the second copy.
	expect(RECONCILE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(
		/'(align|fetch|stems|stems-upgrade)'|stemStatus|lyricsStatus/
	);
});
