/**
 * The TS↔Python vocabulary is enforced HERE, not by comment discipline.
 *
 * The worker is Python and cannot import @encore/shared, so every shared enum is hand-mirrored in
 * apps/worker/src/vocabulary.py and the capability strings are hand-typed in capabilities.py. Core
 * then matches those capability strings by RAW STRING EQUALITY in dispatch.ts. Nothing checked that
 * the two sides agreed — the claim lived only in prose, in both files' doc comments.
 *
 * Drift is silent and expensive: add an engine or an ASR checkpoint on the TS side, forget the Python
 * mirror, and core enqueues a job whose capability no worker advertises. The song then sits at 0%
 * looking like a hung worker, which is exactly the class of defect the derived-capability work was
 * built to eliminate. A review found this the single biggest unguarded contract in the repo.
 *
 * These tests read the Python SOURCE as text rather than executing it, so they need no Python
 * interpreter and run inside the ordinary `bun test` gate — a drift reds a check instead of a party.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ASR_MODELS, SYNC_MODES, SEPARATOR_ENGINES, FETCHERS } from '@encore/shared';
import type { JobType } from '@encore/shared';
import { requiredCapability } from './dispatch';
import { DEFAULT_LEASE_CONFIG } from './leases';
import { INSTRUMENTAL_EXT, VOCALS_EXT, audioKey, instrumentalKey, vocalsKey } from '../media/paths';

const WORKER_SRC = join(import.meta.dir, '../../../../worker/src');
const vocabulary = readFileSync(join(WORKER_SRC, 'vocabulary.py'), 'utf8');
const capabilities = readFileSync(join(WORKER_SRC, 'capabilities.py'), 'utf8');
const protocolPy = readFileSync(join(WORKER_SRC, 'protocol.py'), 'utf8');

/**
 * The ARTIFACT ENVELOPE is a second unguarded contract, and it bit for real.
 *
 * Both separator engines yield `CompleteResult(artifacts={"stems": ..., "songProfile": ...})`, so the
 * profile is a SIBLING of `stems`. The core's `#onComplete` originally reached for
 * `artifacts.stems.songProfile` instead — one level too deep — so the value arrived `undefined` on
 * every single cook. Nothing caught it: the worker's pytest asserted its own dict and the core's
 * bun test asserted its own mock, and neither ever saw the other's shape.
 *
 * The consequence was not a missing chip. Because the `stems` cook gate requires the profile to be
 * PRESENT, every separated song would have sat at "Separating vocals" forever, and the re-cook check
 * reads `hasInstrumental` rather than the gate, so nothing would ever have retried it. A silent
 * whole-library stall from a one-word path difference.
 *
 * So: assert the key sits at the TOP level of the artifacts dict in both engines, the same way the
 * enum parity above is asserted — by reading the Python as text.
 */
/**
 * ONE writer now, not two. The engines used to hand-assemble this dict each — `demucs.py:491` and
 * `roformer.py:257` — which is how one of them came to put `songProfile` in the wrong place. Publishing
 * moved into a single step (`steps/separate.py` PublishStems), so the two engines can no longer disagree
 * about the shape; the worker's own `tests/test_worker_layers.py` E8 asserts that only one step writes
 * each artifact kind.
 *
 * This guard stays anyway, and reads the Python as TEXT, because it is the only check that spans the wire:
 * the worker's pytest asserts its own dict and the core's bun test asserts its own mock, and neither ever
 * sees the other's shape.
 */
const ARTIFACT_WRITERS = ['steps/separate.py'] as const;

describe('artifact envelope parity (worker yield vs core read)', () => {
	for (const file of ARTIFACT_WRITERS) {
		test(`${file} publishes songProfile as a SIBLING of stems, not inside it`, () => {
			const path = join(WORKER_SRC, file);
			// Fail LOUDLY on a moved file rather than vacuously passing on an empty read. A guard that
			// quietly stops guarding is worse than no guard: the whole point is that nobody is watching.
			expect(existsSync(path), `${file} not found under ${WORKER_SRC} — did the module move?`).toBe(true);
			const src = readFileSync(path, 'utf8');
			// The step assigns each kind at the top level of the artifacts dict.
			const assigns = [...src.matchAll(/out\.artifacts\[["'](\w+)["']\]\s*=/g)].map((m) => m[1]!);
			expect(assigns).toContain('stems');
			expect(assigns).toContain('songProfile');
			// ...and never reaches through stems to do it.
			expect(/artifacts\[["']stems["']\]\[["']songProfile["']\]/.test(src)).toBe(false);
		});
	}

	test('core reads it from the top level too — no reaching through stems', () => {
		const raw = readFileSync(join(import.meta.dir, 'worker-hub.ts'), 'utf8');
		// Strip comments before scanning. The comment at that read site DOCUMENTS the bad path in prose,
		// so a naive scan flags its own explanation — the same trap icons.test.ts calls out, where a
		// guard that reds on its own documentation gets deleted within a week. Newlines are preserved so
		// nothing else about the file shifts.
		const hub = raw
			.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
			.replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/./g, ' '));
		expect(hub).toContain('artifacts?.songProfile');
		// The exact drift that shipped once. Guard the shape, not just the presence of a read.
		expect(hub).not.toMatch(/artifacts[^\n]*\.stems[^\n]*songProfile/);
	});
});

/**
 * Every artifact key the worker WRITES must be a member of `JobArtifacts` — the whole class of drift
 * that stalled cooks when `songProfile` shipped undeclared and, most recently, `source` (a `fetch`
 * job's retained-original key) rode this frame written, undeclared and unread (#459). This scan is
 * broader than the `songProfile`-placement guard above: it covers ALL `steps/*.py`, not just
 * `separate.py`, and asserts subset-of-`JobArtifacts` rather than one hard-coded key. Reads both sides
 * as TEXT so it runs in the ordinary `bun test` gate with no Python interpreter and no `@encore/shared`
 * import on the worker side.
 */
describe('every worker-written artifact key is declared in JobArtifacts', () => {
	// Top-level field names of `interface JobArtifacts { ... }`, read from the source as text. Matches
	// `name?:` / `name:` at the start of an indented line inside the interface body — the same
	// read-source-as-text idiom used above, so no build step is needed to know the declared set.
	function declaredArtifactKeys(): Set<string> {
		const events = readFileSync(join(WORKER_SRC, '../../../packages/shared/src/events.ts'), 'utf8');
		const m = events.match(/export interface JobArtifacts \{([\s\S]*?)\n\}/);
		expect(m, 'JobArtifacts interface not found in events.ts').toBeTruthy();
		const body = m![1]!;
		// Field lines only: a single-tab indent then an identifier then optional `?` then `:`. Nested
		// object members are more deeply indented and by design NOT top-level keys, so they are skipped.
		return new Set([...body.matchAll(/^\t(\w+)\??:/gm)].map((x) => x[1]!));
	}

	test('no steps/*.py writes an artifacts key absent from JobArtifacts', () => {
		const declared = declaredArtifactKeys();
		expect(declared.has('stems'), 'sanity: JobArtifacts parsed').toBe(true);
		const stepsDir = join(WORKER_SRC, 'steps');
		const pyFiles = readdirSync(stepsDir).filter((f) => f.endsWith('.py'));
		expect(pyFiles.length, 'no steps/*.py found — did the package move?').toBeGreaterThan(0);
		const offenders: string[] = [];
		for (const f of pyFiles) {
			const src = readFileSync(join(stepsDir, f), 'utf8');
			for (const mm of src.matchAll(/(?:out|ctx\.out)\.artifacts\[["'](\w+)["']\]\s*=/g)) {
				const key = mm[1]!;
				if (!declared.has(key)) offenders.push(`steps/${f}: artifacts["${key}"]`);
			}
		}
		expect(offenders, `worker writes artifact keys not declared in JobArtifacts: ${offenders.join(', ')}`).toEqual([]);
	});
});

/** Members of a `class Name(_StrEnum)` block, by their string VALUE (`FOO = "foo"` → `foo`). */
function pyEnumValues(src: string, className: string): string[] {
	const start = src.indexOf(`class ${className}(_StrEnum):`);
	if (start === -1) throw new Error(`class ${className}(_StrEnum) not found in vocabulary.py`);
	// Stop at the next top-level `class ` or a module-level assignment; both end the block.
	const rest = src.slice(start + 1);
	const endRel = rest.search(/\n(?:class |[A-Z_]+(?::[^\n=]+)? =)/);
	const block = endRel === -1 ? rest : rest.slice(0, endRel);
	return [...block.matchAll(/^\s{4}[A-Z][A-Z0-9_]*\s*=\s*"([^"]+)"/gm)].map((m) => m[1]!);
}

/** Capability tokens the worker can actually advertise, as hand-typed in capabilities.py. */
/**
 * Frame-name constants from `protocol.py`, for one direction. The file groups them under
 * `# worker -> core` / `# core -> worker` comments, so the section is the direction: reading the whole
 * file would conflate the two unions and let a verb move sides unnoticed.
 */
function pyWireVerbs(section: 'worker -> core' | 'core -> worker'): string[] {
	const start = protocolPy.indexOf(`# ${section}`);
	if (start < 0) throw new Error(`protocol.py has no '# ${section}' section — did the grouping change?`);
	const rest = protocolPy.slice(start + section.length);
	// Stop at the NEXT comment line of any kind: the direction markers are themselves comments, so
	// they delimit the groups. (An earlier version excluded the markers from this stop, which merged
	// both directions into one list — caught by the worker→core assertion, not by review.)
	const end = rest.search(/\n#/);
	const body = end < 0 ? rest : rest.slice(0, end);
	return [...body.matchAll(/^[A-Z_]+ = "([^"]+)"/gm)].map((m) => m[1]!);
}

function pyCapabilityTokens(): string[] {
	return [...capabilities.matchAll(/Probe\(\s*"([^"]+)"/g)].map((m) => m[1]!);
}

describe('TS↔Python vocabulary parity', () => {
	test('JobType matches the worker Action enum', () => {
		// JobType is a bare union type, so it has no runtime value to import — the union is asserted
		// against the Python enum via an explicit list that TypeScript itself checks below.
		const tsJobTypes = ['fetch', 'stems', 'stems-upgrade', 'align'] as const;
		// If JobType ever gains or loses a member, this assignment stops compiling, so the list above
		// cannot silently fall behind the type it mirrors.
		const _exhaustive: readonly import('@encore/shared').JobType[] = tsJobTypes;
		void _exhaustive;
		expect([...pyEnumValues(vocabulary, 'Action')].sort()).toEqual([...tsJobTypes].sort());
	});

	test('ASR checkpoints match the worker AsrModel enum', () => {
		expect(pyEnumValues(vocabulary, 'AsrModel').sort()).toEqual(ASR_MODELS.map((m) => m.id).sort());
	});

	test('sync modes match the worker SyncMode enum', () => {
		expect(pyEnumValues(vocabulary, 'SyncMode').sort()).toEqual(SYNC_MODES.map((m) => m.id).sort());
	});

	test('separator engines match the worker Engine enum', () => {
		expect(pyEnumValues(vocabulary, 'Engine').sort()).toEqual(SEPARATOR_ENGINES.map((e) => e.id).sort());
	});

	test('fetchers match the worker Fetcher enum', () => {
		expect(pyEnumValues(vocabulary, 'Fetcher').sort()).toEqual(FETCHERS.map((f) => f.id).sort());
	});

	// vocabulary.py is read once at module load; if it ever moves, that read throws a bare ENOENT and
	// every parity test above fails for the wrong reason. Assert its presence loudly, the same way the
	// artifact-envelope block guards its per-file reads, so a moved file names itself.
	test('vocabulary.py is where the parity reads expect it', () => {
		const path = join(WORKER_SRC, 'vocabulary.py');
		expect(existsSync(path), `vocabulary.py not found under ${WORKER_SRC} — did the module move?`).toBe(true);
	});

	test('lyrics text sources match the worker TextSource enum', () => {
		// LyricsTextSource is a bare union with no runtime value to import, so — exactly like JobType
		// above — the members are listed explicitly and TypeScript checks the list IS the union, so it
		// cannot silently fall behind. The Python side is TextSource, promoted from chain.py's SOURCE_*
		// string constants precisely so this guard can cover it.
		const tsTextSources = ['lrclib', 'captions', 'asr', 'manual'] as const;
		const _exhaustive: readonly import('@encore/shared').LyricsTextSource[] = tsTextSources;
		void _exhaustive;
		expect(pyEnumValues(vocabulary, 'TextSource').sort()).toEqual([...tsTextSources].sort());
	});

	test('lyrics timing tiers match the worker Timing enum', () => {
		const tsTimings = ['word', 'line', 'none'] as const;
		const _exhaustive: readonly import('@encore/shared').LyricsTiming[] = tsTimings;
		void _exhaustive;
		expect(pyEnumValues(vocabulary, 'Timing').sort()).toEqual([...tsTimings].sort());
	});

	test('every engine capability string is one the worker can advertise', () => {
		// This is the pairing dispatch.ts compares with raw `capabilities.includes(cap)`, so a typo on
		// either side parks the job forever rather than failing loudly.
		const advertisable = new Set(pyCapabilityTokens());
		const missing = SEPARATOR_ENGINES.map((e) => e.capability).filter((c) => !advertisable.has(c));
		expect(missing).toEqual([]);
	});

	test('every fetcher capability the core routes on is one the worker can advertise', () => {
		const advertisable = new Set(pyCapabilityTokens());
		// `local` needs no worker — it is served from the media volume, so it advertises nothing.
		const routed = FETCHERS.filter((f) => f.id !== 'local').map((f) => `fetch:${f.id}`);
		expect(routed.filter((c) => !advertisable.has(c))).toEqual([]);
	});

	/**
	 * The two assertions above enumerate the engine and fetcher capability TABLES, but the core does
	 * not route on a table — it routes on `requiredCapability(jobType)` (dispatch.ts), whose LAST
	 * branch is a bare `return jobType`. That fall-through covers `align`, whose capability lives in
	 * neither `SEPARATOR_ENGINES` nor `FETCHERS`, so neither assertion above ever reaches it: rename
	 * the worker's `align` probe (the natural change the moment align gains a second backend, exactly
	 * as `stems` grew `stems:roformer`) and every align job is routed on a capability no worker can
	 * advertise, parking silently at 0% with both suites green. Assert the ROUTED set directly —
	 * every JobType's required capability must be advertisable — which subsumes both checks above and
	 * closes the fall-through. `align` and `stems-upgrade` are the members the enumerations miss.
	 */
	test('every JobType routes to a capability the worker can advertise', () => {
		// TypeScript checks this list IS the JobType union (same trick as the enum tests), so it
		// cannot silently fall behind if a job type is added.
		const jobTypes = ['fetch', 'stems', 'stems-upgrade', 'align'] as const;
		const _exhaustive: readonly JobType[] = jobTypes;
		void _exhaustive;
		const advertisable = new Set(pyCapabilityTokens());
		// With no settings, requiredCapability returns each type's DEFAULT-routed capability — the one
		// a job actually carries when the operator has not overridden the engine. That is the set the
		// worker must be able to serve out of the box.
		const missing = jobTypes
			.map((jt) => ({ jt, cap: requiredCapability(jt) }))
			.filter(({ cap }) => !advertisable.has(cap));
		expect(missing).toEqual([]);
	});
	/**
	 * The WIRE VERBS were the last contract in this file guarded only by a comment.
	 *
	 * `protocol.py` carries `# message type strings (must match packages/shared/src/events.ts)` above
	 * eleven frame names, and nothing checked it. Rename a frame on either side and every test here
	 * stayed green while the worker silently ignored an unrecognised `type` (or the core dropped the
	 * worker's) — a worker that connects, handshakes, and then never accepts a job. That is the same
	 * "hung worker at 0%" signature the capability-derivation work was written to end, one layer up.
	 */
	test('worker→core frame names match the WorkerMessage union', () => {
		const tsWorkerMessages = [
			'worker:hello',
			'worker:heartbeat',
			'job:accept',
			'job:reject',
			'job:progress',
			'job:complete',
			'job:failed'
		] as const;
		// Same trick as JobType above: TypeScript checks the list IS the union, so it cannot fall behind.
		const _exhaustive: readonly import('@encore/shared').WorkerMessage['type'][] = tsWorkerMessages;
		void _exhaustive;
		expect(pyWireVerbs('worker -> core').sort()).toEqual([...tsWorkerMessages].sort());
	});

	test('core→worker frame names match the WorkerCommand union', () => {
		const tsWorkerCommands = ['worker:welcome', 'job:assign', 'job:cancel', 'ping'] as const;
		const _exhaustive: readonly import('@encore/shared').WorkerCommand['type'][] = tsWorkerCommands;
		void _exhaustive;
		expect(pyWireVerbs('core -> worker').sort()).toEqual([...tsWorkerCommands].sort());
	});

	/**
	 * `Stage` was the one worker enum this file did not cross-check. The worker emits it as
	 * `job:progress.stage`, typed `MediaStatus`, and the core rebroadcasts it to phones — so a stage
	 * the union does not contain is a progress row that renders no label or freezes mid-cook. Subset,
	 * not equality: `queued`/`ready`/`failed`/`canceled` are core-side states no worker emits.
	 */
	test('worker stages are all valid MediaStatus values', () => {
		const tsMediaStatuses = ['queued', 'downloading', 'separating', 'aligning', 'ready', 'failed', 'canceled'] as const;
		const _exhaustive: readonly import('@encore/shared').MediaStatus[] = tsMediaStatuses;
		void _exhaustive;
		const stages = pyEnumValues(vocabulary, 'Stage');
		expect(stages.length).toBeGreaterThan(0); // a silent empty parse would pass vacuously
		expect(stages.filter((s) => !tsMediaStatuses.includes(s as never))).toEqual([]);
	});

	test('protocol.py is where the wire-verb read expects it', () => {
		const path = join(WORKER_SRC, 'protocol.py');
		expect(existsSync(path), `protocol.py not found under ${WORKER_SRC} — did the module move?`).toBe(true);
	});
});

/**
 * The roformer TOKEN→CHECKPOINT identity, which is currently BROKEN ON PURPOSE.
 *
 * `separators.ts` offers `bs-roformer-1297` to phones as selectable, ranks it 35 ("highest separation
 * quality") and carries a measured `rtFactor` of 8.28. The worker resolves that same token to
 * `roformer-model-bs-roformer-sw-by-jarredou`, which is `BS-Rofo-SW-Fixed.ckpt` — NOT the
 * `model_bs_roformer_ep_317_sdr_12.9755.ckpt` those numbers were measured against. `roformer.py` says
 * so in a `⚠️ KNOWN MISMATCH` comment.
 *
 * A comment cannot fail. These tests pin the divergence instead: the first asserts every roformer token
 * the UI offers is resolvable at all (the prior bug was a token mapping to no registry slug), and the
 * second pins the mapping AS IT IS, so repointing it to the checkpoint those quality numbers were
 * actually measured against has
 * to come here and state that it did. Neither test blesses the mismatch; they stop it being silent.
 */
describe('roformer token ↔ checkpoint identity', () => {
	const roformerPy = readFileSync(join(WORKER_SRC, 'separation/roformer.py'), 'utf8');

	function pyRoformerModels(): Record<string, string> {
		// Anchor to a MODULE-LEVEL assignment (^ under the m flag = column 0). Python indents nothing
		// at module scope and a comment begins with `#`, so a `# ROFORMER_MODELS = {...}` line above
		// the live table can no longer be the first (unanchored) match and mask a real divergence.
		const block = roformerPy.match(/^ROFORMER_MODELS\s*=\s*\{([\s\S]*?)\n\}/m);
		if (!block)
			throw new Error(
				'ROFORMER_MODELS not found at module level in roformer.py — did the table move or get commented out?'
			);
		const out: Record<string, string> = {};
		for (const m of block[1]!.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) out[m[1]!] = m[2]!;
		return out;
	}

	test('every roformer model the UI offers resolves to a slug the worker can run', () => {
		const mapped = pyRoformerModels();
		expect(Object.keys(mapped).length).toBeGreaterThan(0);
		const offered = SEPARATOR_ENGINES.filter((e) => e.id === 'roformer').flatMap((e) => e.models.map((m) => m.id));
		expect(offered.length).toBeGreaterThan(0);
		expect(offered.filter((id) => !mapped[id])).toEqual([]);
	});

	test('bs-roformer-1297 still resolves to the KNOWN-MISMATCHED slug, not the benchmarked one', () => {
		// Change this only together with the rtFactor/rank in separators.ts and the comment in
		// roformer.py — the point of the pin is that the three move as one.
		expect(pyRoformerModels()['bs-roformer-1297']).toBe('roformer-model-bs-roformer-sw-by-jarredou');
	});
});

/**
 * The WORKER'S ML KEEPALIVE and the CORE'S PROGRESS LEASE are a cross-service invariant that nothing
 * pinned. `run_blocking` (runtime/runner.py) is the ONLY thing emitting `job:progress` during an
 * in-process whisper/wav2vec2 pass: `asyncio.wait({task}, timeout=LEASE_KEEPALIVE_SEC)` wakes every
 * `LEASE_KEEPALIVE_SEC` seconds to yield a progress tick. Core's reaper (leases.ts) requeues a running
 * job whose last progress is older than `progressLeaseMs`, so if the keepalive interval ever creeps
 * above that lease a HEALTHY cook goes silent past the deadline and the reaper kills it — reason
 * `progress-lease-expired`, then at `maxAttempts` a false `worker died` failure, each retry a full ASR
 * pass. Production is correct today (10s < 30s), so this is an UNGUARDED invariant, not a live defect:
 * raising the constant to any value ≥ 30 ships with the whole worker suite green, because the two tests
 * that read as its coverage (test_align_plan.py, test_runtime.py) each `monkeypatch` the constant to
 * 0.02 and so pin nothing about its real value.
 *
 * Guard it the same way the parity checks above do — by reading the Python SOURCE as text, so a drift
 * reds this `bun test` check with no Python interpreter. Assert a MARGIN, not merely `<`: one missed
 * keepalive must not expire the lease, so the interval must sit comfortably under it (the constant's own
 * comment says "comfortably under"). Half the lease is that margin.
 */
describe('worker ML keepalive stays under the core progress lease', () => {
	const runnerPy = readFileSync(join(WORKER_SRC, 'runtime/runner.py'), 'utf8');
	// Python's effective value is the LAST module-level assignment. Take the last column-0 match, not
	// the first, so a triple-quoted string containing `LEASE_KEEPALIVE_SEC = <value>` above the real
	// assignment cannot shadow it and hide a drifted constant. (Folded in from the #300 review.)
	const lastKeepaliveSec = (): number | null => {
		const ms = [...runnerPy.matchAll(/^LEASE_KEEPALIVE_SEC = ([\d.]+)/gm)];
		const last = ms[ms.length - 1];
		return last ? Number(last[1]) : null;
	};

	test('LEASE_KEEPALIVE_SEC is defined and read as a number', () => {
		const sec = lastKeepaliveSec();
		expect(sec).not.toBeNull();
		expect(Number.isFinite(sec!)).toBe(true);
	});

	test('the keepalive interval sits comfortably under the core progress lease', () => {
		const keepaliveMs = lastKeepaliveSec()! * 1000;
		// A margin, not `<`: one dropped keepalive must not already breach the lease.
		expect(keepaliveMs).toBeLessThan(DEFAULT_LEASE_CONFIG.progressLeaseMs / 2);
	});

	/**
	 * The OTHER side of the same wire, previously unguarded (#308): the core ADVERTISES
	 * `heartbeatIntervalSec` in the welcome handshake (worker-hub.ts). A worker that HONOURS the
	 * advertised value paces its own `job:progress` by it, so the advertised interval is bound by the
	 * SAME margin the worker constant above is: at the full lease, a worker doing exactly as told
	 * emits its next tick right at the deadline and one dropped tick breaches it. The value it
	 * advertises must therefore also sit under `progressLeaseMs / 2`.
	 *
	 * Read worker-hub.ts as TEXT and compute the advertised seconds from the divisor chain the source
	 * applies to progressLeaseMs — NOT by re-evaluating the code's own expression. Dropping the `/ 2`
	 * changes the divisors this extracts, so the computed value reds this check.
	 */
	const hubRaw = readFileSync(join(import.meta.dir, 'worker-hub.ts'), 'utf8');
	const hubStripped = hubRaw
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/./g, ' '));

	test('core advertises heartbeatIntervalSec derived from progressLeaseMs', () => {
		// The advertisement must be a Math.floor over progressLeaseMs and nothing else, so the value
		// tracks the lease rather than being a hard-coded number that can silently desync from it.
		const m = /heartbeatIntervalSec:\s*Math\.floor\(\s*this\.#config\.progressLeaseMs\s*((?:\/\s*\d+\s*)+)\)/.exec(
			hubStripped
		);
		expect(
			m,
			'heartbeatIntervalSec advertisement not found in worker-hub.ts — did it move or stop deriving from progressLeaseMs?'
		).not.toBeNull();
	});

	test('the advertised heartbeat interval sits comfortably under the core progress lease', () => {
		const m = /heartbeatIntervalSec:\s*Math\.floor\(\s*this\.#config\.progressLeaseMs\s*((?:\/\s*\d+\s*)+)\)/.exec(
			hubStripped
		);
		// Compute the advertised value from the divisor literals the source applies — an INDEPENDENT
		// computation over DEFAULT_LEASE_CONFIG, not a copy of the code's expression. The divisors are
		// the only free variable, so a dropped `/ 2` reds this.
		const divisors = m![1].match(/\d+/g)!.map(Number);
		expect(divisors.length).toBeGreaterThan(0); // a vacuous parse would divide by nothing
		const advertisedSec = Math.floor(divisors.reduce((acc, d) => acc / d, DEFAULT_LEASE_CONFIG.progressLeaseMs));
		const advertisedMs = advertisedSec * 1000;
		// AT MOST half the lease. Half is the margin: a worker honouring 15s emits its next tick at
		// 30s == the deadline after one dropped tick, so it does not breach; the full lease (30s) does.
		// `<=` because exactly-half is the intended value the fix ships (advertising the full lease is
		// what reds — 30000 is not <= 15000).
		expect(advertisedMs).toBeLessThanOrEqual(DEFAULT_LEASE_CONFIG.progressLeaseMs / 2);
	});
});

/**
 * The STEM EXTENSION / KEY MIRROR is the last cross-language contract in the media layer guarded only
 * by prose (#440). Both sides declare it MUST agree byte-for-byte:
 *
 *  - core `apps/core/src/server/media/paths.ts` — `INSTRUMENTAL_EXT`, `VOCALS_EXT`, and the key
 *    builders `audioKey` / `instrumentalKey` / `vocalsKey` (what goes in the DB and on the wire).
 *  - worker `apps/worker/src/processor.py` — `INSTRUMENTAL_EXT`, `VOCALS_EXT`, and the path builders
 *    `instrumental_path` / `vocals_path` / `source_audio_path` (what the worker writes to disk).
 *
 * The TV resolves `/media/<ref>`, so a mismatch is SILENT: the file exists, the player 404s. And the
 * drift is not merely a 404 — change `VOCALS_EXT` in `processor.py` alone and `retention.ts` /
 * `vocals-backfill.ts` build a key for a file that no longer exists, so eviction silently skips the
 * real vocals stem (disk never reclaimed) and backfill no-ops. Nothing crossed this seam: no worker
 * test opens `paths.ts`, `layout.test.ts` asserts the TS literals against themselves, and the
 * artifact-envelope block above covers key NESTING only, never a path STRING.
 *
 * Guard it the same way the parity checks above do — read `processor.py` as TEXT (no Python
 * interpreter) and compare the extracted constants and path shapes against the IMPORTED core
 * constants and the REAL core key builders, so a drift on EITHER side reds this `bun test` check.
 */
describe('stem path/extension parity (worker processor.py vs core paths.ts)', () => {
	const PROCESSOR_REL = 'processor.py';
	const processorPath = join(WORKER_SRC, PROCESSOR_REL);
	const processorPy = readFileSync(processorPath, 'utf8');

	// A fixed sample id, run through the real core key builders, is the byte-for-byte reference the
	// worker path must reproduce. Using the builders (not a re-typed literal) makes this a genuine
	// cross-seam check: if the core builder shape changes, the reference moves with it.
	const ID = 'sample-media-id';

	/** A `NAME = "value"` module-level string constant in processor.py, by name. Throws if absent. */
	function pyStrConst(name: string): string {
		const m = new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm').exec(processorPy);
		if (!m) throw new Error(`${name} not found as a module-level string in ${PROCESSOR_REL}`);
		return m[1]!;
	}

	/**
	 * The relative ref a `*_path` builder produces for ID, reconstructed from the `os.path.join(...)`
	 * call in its body — read as TEXT, never executed. `media_dir` is the volume root the caller
	 * supplies (it is NOT part of the ref that goes on the wire), so it is dropped; every other
	 * segment is a string literal or an f-string over `media_id` / an EXT constant, which we expand
	 * with the values we already extracted. A shape change (a renamed segment, a dropped `derived/`,
	 * a hard-coded extension) changes the reconstructed ref and reds the comparison below.
	 */
	function pyPathRef(fnName: string, subs: Record<string, string>): string {
		const fn = new RegExp(`def ${fnName}\\([^)]*\\)[^:]*:([\\s\\S]*?)\\n(?:def |[A-Za-z@#])`, 'm').exec(
			processorPy + '\ndef '
		);
		if (!fn) throw new Error(`def ${fnName} not found in ${PROCESSOR_REL}`);
		// Grab the WHOLE return line, then peel the outer os.path.join(...) by taking everything
		// between its first `(` and the LAST `)` on that line — a non-greedy match stops at the inner
		// `)` of a call like `ext.lstrip('.')` and truncates the arg list.
		const retLine = /return\s+os\.path\.join\(([\s\S]*)\)\s*$/m.exec(fn[1]!);
		if (!retLine) throw new Error(`${fnName} does not end in os.path.join(...) — shape changed?`);
		const joinCall = retLine;
		// Split the join args at top-level commas; the first is media_dir (the volume root, not part
		// of the wire ref) so it is dropped.
		const args = joinCall[1]!
			.split(',')
			.map((a) => a.trim())
			.filter((a) => a.length > 0);
		if (args[0] !== 'media_dir') throw new Error(`${fnName} does not join under media_dir first`);
		const segs = args.slice(1).map((a) => {
			// A bare string segment: "derived", "stems", "audio".
			const lit = /^"([^"]*)"$/.exec(a);
			if (lit) return lit[1]!;
			// An f-string filename: f"{media_id}-instrumental.{INSTRUMENTAL_EXT}" etc. Expand the two
			// interpolation forms we know: {media_id}[.lstrip(...)] and {<EXT const>}. Anything else is
			// an unrecognised shape and must fail loudly rather than pass a half-parsed ref.
			const fstr = /^f"([^"]*)"$/.exec(a);
			if (!fstr) throw new Error(`${fnName}: unrecognised join segment ${a}`);
			return fstr[1]!.replace(/\{([^}]+)\}/g, (_all, expr: string) => {
				const key = expr.split('.')[0]!.trim(); // media_id, media_id.lstrip('.'), INSTRUMENTAL_EXT…
				if (key === 'media_id') return subs.media_id!;
				if (key === 'ext') return subs.ext ?? '';
				if (key in subs) return subs[key]!;
				throw new Error(`${fnName}: cannot expand {${expr}} — unknown interpolation`);
			});
		});
		return segs.join('/');
	}

	test('processor.py is where the parity read expects it', () => {
		expect(existsSync(processorPath), `${PROCESSOR_REL} not found under ${WORKER_SRC} — did the module move?`).toBe(
			true
		);
	});

	test('INSTRUMENTAL_EXT / VOCALS_EXT agree across the seam', () => {
		expect(pyStrConst('INSTRUMENTAL_EXT')).toBe(INSTRUMENTAL_EXT);
		expect(pyStrConst('VOCALS_EXT')).toBe(VOCALS_EXT);
	});

	test('the instrumental stem key agrees byte-for-byte', () => {
		const worker = pyPathRef('instrumental_path', {
			media_id: ID,
			INSTRUMENTAL_EXT: pyStrConst('INSTRUMENTAL_EXT')
		});
		expect(worker).toBe(instrumentalKey(ID));
	});

	test('the vocals stem key agrees byte-for-byte', () => {
		const worker = pyPathRef('vocals_path', {
			media_id: ID,
			VOCALS_EXT: pyStrConst('VOCALS_EXT')
		});
		expect(worker).toBe(vocalsKey(ID));
	});

	test('the raw source-audio key agrees byte-for-byte', () => {
		// source_audio_path interpolates media_id and a default ext="wav"; audioKey defaults the same.
		const worker = pyPathRef('source_audio_path', { media_id: ID, ext: 'wav' });
		expect(worker).toBe(audioKey(ID, 'wav'));
	});

	test('non-vacuity: the extracted keys are non-empty, stem-shaped derived refs', () => {
		// A silent empty parse (renamed fn, changed join shape) would let a comparison pass vacuously.
		// Pin the concrete shape so the guard cannot degrade into asserting '' === ''.
		const ins = pyPathRef('instrumental_path', {
			media_id: ID,
			INSTRUMENTAL_EXT: pyStrConst('INSTRUMENTAL_EXT')
		});
		const voc = pyPathRef('vocals_path', { media_id: ID, VOCALS_EXT: pyStrConst('VOCALS_EXT') });
		expect(ins).toMatch(/^derived\/stems\/.+-instrumental\..+$/);
		expect(voc).toMatch(/^derived\/stems\/.+-vocals\..+$/);
		expect(pyStrConst('INSTRUMENTAL_EXT').length).toBeGreaterThan(0);
		expect(pyStrConst('VOCALS_EXT').length).toBeGreaterThan(0);
	});
});

/**
 * The DEMUCS_MODELS WHITELIST is the roformer table's twin, and until now the ONLY half of the
 * separator contract with no guard.
 *
 * `demucs.py` carries `DEMUCS_MODELS = ("htdemucs", ...)` under a comment that says it "Mirrors the
 * `demucs` engine's model whitelist in packages/shared/src/separators.ts" — but nothing enforced the
 * mirror. Its roformer twin IS guarded (the token↔checkpoint block above reads ROFORMER_MODELS as
 * text and pins it against the offered set); the demucs side lived only in that prose comment.
 *
 * The drift this stops is concrete: add a fourth checkpoint to `separators.ts` and it becomes
 * selectable in room settings, but the worker's `resolve_demucs_model` rejects any id not in
 * DEMUCS_MODELS. The core validated the engine+model pairing against `separators.ts` before
 * enqueueing, so every cook of that song then hits `demucs.py`'s `ValueError` — a permanent config
 * error that no retry can fix, burned `maxAttempts` times. Guard it the same way the roformer twin
 * is: read the Python tuple as TEXT (no interpreter, runs in `bun test`) and assert it agrees, in
 * both directions, with the demucs engine's offered model ids.
 */
describe('demucs model whitelist parity (worker DEMUCS_MODELS ↔ separators.ts)', () => {
	const demucsPy = readFileSync(join(WORKER_SRC, 'separation/demucs.py'), 'utf8');

	/** The ids in `DEMUCS_MODELS = ("a", "b", ...)`, read from demucs.py as text. */
	function pyDemucsModels(): string[] {
		// Anchor to a MODULE-LEVEL assignment (^ under the m flag = column 0). Unanchored, String.match
		// takes the FIRST occurrence, so a commented-out CORRECT tuple parked above a live WRONG one
		// would parse the comment and pass on a genuine drift — a false EXEMPT on the exact divergence
		// this guard exists to catch. A `#`-commented line cannot start at column 0, so it is skipped.
		const block = demucsPy.match(/^DEMUCS_MODELS\s*=\s*\(([\s\S]*?)\)/m);
		if (!block)
			throw new Error(
				'DEMUCS_MODELS not found at module level in demucs.py — did the tuple move or get commented out?'
			);
		return [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
	}

	/** The model ids the `demucs` engine offers phones in the shared registry. */
	function offeredDemucsModels(): string[] {
		return SEPARATOR_ENGINES.filter((e) => e.id === 'demucs').flatMap((e) => e.models.map((m) => m.id));
	}

	test('the worker whitelist and the offered set agree exactly, in both directions', () => {
		const worker = pyDemucsModels();
		const offered = offeredDemucsModels();
		// Non-vacuity floor: a silent empty parse on either side would let the equality pass with
		// nothing in it, exactly the trap the roformer/stage guards above call out.
		expect(worker.length, 'DEMUCS_MODELS parsed empty from demucs.py — did the tuple change shape?').toBeGreaterThan(0);
		expect(
			offered.length,
			'the demucs engine offers no models in separators.ts — did the registry move?'
		).toBeGreaterThan(0);
		// Set equality both directions: a model selectable in room settings the worker will reject
		// (offered ⊄ worker) parks every cook of it on a non-retryable ValueError; a worker checkpoint
		// no UI offers (worker ⊄ offered) is dead config that drifts unnoticed.
		expect([...worker].sort()).toEqual([...offered].sort());
	});

	test('demucs.py is where the whitelist read expects it', () => {
		const path = join(WORKER_SRC, 'separation/demucs.py');
		expect(existsSync(path), `demucs.py not found under ${WORKER_SRC} — did the module move?`).toBe(true);
	});
});
