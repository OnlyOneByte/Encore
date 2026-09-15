/**
 * The TS↔Python vocabulary is enforced HERE, not by comment discipline.
 *
 * The worker is Python and cannot import $lib/contract, so every shared enum is hand-mirrored in
 * apps/worker/src/vocabulary.py — capability tokens included, as the `Capability` enum. Core
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
import {
	ASR_MODELS,
	SYNC_MODES,
	SEPARATOR_ENGINES,
	FETCHERS,
	EMPTY_SONG_PROFILE,
	normalizeSongProfile
} from '$lib/contract';
import type { JobType } from '$lib/contract';
import { requiredCapability } from '$lib/server/jobs/dispatch';
import { DEFAULT_LEASE_CONFIG } from '$lib/server/jobs/leases';
import {
	INSTRUMENTAL_EXT,
	VOCALS_EXT,
	GUIDE_MIX_EXT,
	audioKey,
	instrumentalKey,
	vocalsKey,
	guideMixKey,
	rawCaptionKey
} from '$lib/server/media/paths';
import { SILENCE_FLOOR_DB } from '$lib/server/media/loudness';
import { at } from '@encore/test-support';

const WORKER_SRC = at('worker/src');
const vocabulary = readFileSync(join(WORKER_SRC, 'vocabulary.py'), 'utf8');
const protocolPy = readFileSync(join(WORKER_SRC, 'protocol.py'), 'utf8');

/**
 * The ARTIFACT ENVELOPE is a second unguarded contract, and it bit for real.
 *
 * Both separator engines yield `CompleteResult(artifacts={"stems": ..., "songProfile": ...})`, so the
 * profile is a SIBLING of `stems`. The core's `#onComplete` originally reached for
 * `artifacts.stems.songProfile` instead — one level too deep — so the value arrived `undefined` on
 * every single process. Nothing caught it: the worker's pytest asserted its own dict and the core's
 * bun test asserted its own mock, and neither ever saw the other's shape.
 *
 * The consequence was not a missing chip. Because the `stems` process gate requires the profile to be
 * PRESENT, every separated song would have sat at "Separating vocals" forever, and the re-process check
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
		const raw = readFileSync(at('src/lib/server/jobs/worker-hub.ts'), 'utf8');
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
 * that stalled processes when `songProfile` shipped undeclared and, most recently, `source` (a `fetch`
 * job's retained-original key) rode this frame written, undeclared and unread. This scan is
 * broader than the `songProfile`-placement guard above: it covers ALL `steps/*.py`, not just
 * `separate.py`, and asserts subset-of-`JobArtifacts` rather than one hard-coded key. Reads both sides
 * as TEXT so it runs in the ordinary `bun test` gate with no Python interpreter and no `$lib/contract`
 * import on the worker side.
 */
describe('every worker-written artifact key is declared in JobArtifacts', () => {
	// Top-level field names of `interface JobArtifacts { ... }`, read from the source as text. Matches
	// `name?:` / `name:` at the start of an indented line inside the interface body — the same
	// read-source-as-text idiom used above, so no build step is needed to know the declared set.
	function declaredArtifactKeys(): Set<string> {
		const events = readFileSync(at('src/lib/contract/core/events.ts'), 'utf8');
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
	// Also stop at a module-level `def `: `Capability` is followed by `serves_family`, and without this
	// the block ran past it to the next class. Harmless today — a function body carries no 4-space
	// `UPPER = "..."` line — but it can only ever ADD false members, never drop real ones.
	const endRel = rest.search(/\n(?:class |def |[A-Z_]+(?::[^\n=]+)? =)/);
	const block = endRel === -1 ? rest : rest.slice(0, endRel);
	return [...block.matchAll(/^\s{4}[A-Z][A-Z0-9_]*\s*=\s*"([^"]+)"/gm)].map((m) => m[1]!);
}

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
	// Read the `Capability` enum in vocabulary.py — the capability tokens' single source of truth.
	//
	// This used to grep `capabilities.py` for `Probe("<token>")` string literals, because that is where
	// the tokens were hand-typed. They are not any more: they were promoted to a `Capability(_StrEnum)`
	// beside `Backend` and `Timing`, so the probes read `Probe(Capability.FETCH_YTDLP, ...)` and the
	// literal grep silently matched NOTHING. An empty advertisable set makes every routed capability
	// "missing", which is what the three assertions below reported.
	//
	// Reading the enum is the better contract anyway: the worker's own suite asserts the probes and the
	// enum are the same set (test_capability_vocabulary.py::test_every_probed_token_is_a_known_capability),
	// so this side reads the DEFINITION while that side guarantees the probes match it.
	const tokens = pyEnumValues(vocabulary, 'Capability');
	// Non-vacuity: an empty list would make every assertion below pass by having nothing to check —
	// exactly how the literal grep failed OPEN when the tokens moved.
	if (tokens.length === 0)
		throw new Error('no Capability members found in vocabulary.py — the extraction broke');
	return tokens;
}

describe('TS↔Python vocabulary parity', () => {
	test('JobType matches the worker Action enum', () => {
		// JobType is a bare union type, so it has no runtime value to import — the union is asserted
		// against the Python enum via an explicit list that TypeScript itself checks below.
		const tsJobTypes = ['fetch', 'stems', 'stems-upgrade', 'align'] as const;
		// If JobType ever gains or loses a member, this assignment stops compiling, so the list above
		// cannot silently fall behind the type it mirrors.
		const _exhaustive: readonly import('$lib/contract').JobType[] = tsJobTypes;
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
		const _exhaustive: readonly import('$lib/contract').LyricsTextSource[] = tsTextSources;
		void _exhaustive;
		expect(pyEnumValues(vocabulary, 'TextSource').sort()).toEqual([...tsTextSources].sort());
	});

	test('lyrics timing tiers match the worker Timing enum', () => {
		const tsTimings = ['word', 'line', 'none'] as const;
		const _exhaustive: readonly import('$lib/contract').LyricsTiming[] = tsTimings;
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
	 * `protocol.py` carries `# message type strings (must match packages/shared/src/core/events.ts)` above
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
		const _exhaustive: readonly import('$lib/contract').WorkerMessage['type'][] = tsWorkerMessages;
		void _exhaustive;
		expect(pyWireVerbs('worker -> core').sort()).toEqual([...tsWorkerMessages].sort());
	});

	test('core→worker frame names match the WorkerCommand union', () => {
		const tsWorkerCommands = ['worker:welcome', 'job:assign', 'job:cancel', 'ping'] as const;
		const _exhaustive: readonly import('$lib/contract').WorkerCommand['type'][] = tsWorkerCommands;
		void _exhaustive;
		expect(pyWireVerbs('core -> worker').sort()).toEqual([...tsWorkerCommands].sort());
	});

	/**
	 * `Stage` was the one worker enum this file did not cross-check. The worker emits it as
	 * `job:progress.stage`, typed `MediaStatus`, and the core rebroadcasts it to phones — so a stage
	 * the union does not contain is a progress row that renders no label or freezes mid-process. Subset,
	 * not equality: `queued`/`ready`/`failed`/`canceled` are core-side states no worker emits.
	 */
	test('worker stages are all valid MediaStatus values', () => {
		const tsMediaStatuses = ['queued', 'downloading', 'separating', 'aligning', 'ready', 'failed', 'canceled'] as const;
		const _exhaustive: readonly import('$lib/contract').MediaStatus[] = tsMediaStatuses;
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
 * above that lease a HEALTHY process goes silent past the deadline and the reaper kills it — reason
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
	// assignment cannot shadow it and hide a drifted constant. (Folded in from the review.)
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
	 * The OTHER side of the same wire, previously unguarded: the core ADVERTISES
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
	const hubRaw = readFileSync(at('src/lib/server/jobs/worker-hub.ts'), 'utf8');
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
 * by prose. Both sides declare it MUST agree byte-for-byte:
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
			// A bare identifier segment passed as a runtime argument, e.g. `kind` in raw_caption_path.
			// It is not a literal in the source; resolve it from the same subs map the caller supplies
			// so the reconstructed ref uses the concrete value under test.
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) {
				if (a in subs) return subs[a]!;
				throw new Error(`${fnName}: bare segment ${a} has no value in subs`);
			}
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
		expect(pyStrConst('GUIDE_MIX_EXT')).toBe(GUIDE_MIX_EXT);
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

	test('the GUIDE MIX key agrees byte-for-byte', () => {
		// The fifth builder to cross this seam. The mix is what the TV plays as MASTER on a mix song, so a
		// key mismatch is not a missing enhancement — it is a 404 on the file the room is trying to play,
		// and `guidePath` has already committed to the mix path by then.
		const worker = pyPathRef('guide_mix_path', {
			media_id: ID,
			GUIDE_MIX_EXT: pyStrConst('GUIDE_MIX_EXT')
		});
		expect(worker).toBe(guideMixKey(ID));
		// Non-vacuity: pyPathRef returning '' on a parse miss would make the comparison trivially true if
		// guideMixKey ever returned '' too. Pin the SHAPE as well as the equality.
		expect(worker).toMatch(/^derived\/stems\/.+-guidemix\..+$/);
	});

	test('the raw source-audio key agrees byte-for-byte', () => {
		// source_audio_path interpolates media_id and a default ext="wav"; audioKey defaults the same.
		const worker = pyPathRef('source_audio_path', { media_id: ID, ext: 'wav' });
		expect(worker).toBe(audioKey(ID, 'wav'));
	});

	test('the retained raw caption key agrees byte-for-byte', () => {
		// raw_caption_path(media_dir, media_id, kind, ext="vtt") is the FOURTH path builder that crosses
		// this seam; shipped it with no parity guard, and retention.ts enumerates it per (kind, ext)
		// to count and evict the retained track. Check BOTH kinds and BOTH known exts so a drift on either
		// side of the seam reds this. `kind` is a bare runtime arg, so it is supplied via subs.
		for (const kind of ['captions', 'auto-captions']) {
			for (const ext of ['vtt', 'srt']) {
				const worker = pyPathRef('raw_caption_path', { media_id: ID, kind, ext });
				expect(worker).toBe(rawCaptionKey(ID, kind, ext));
			}
		}
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
		// A renamed segment or dropped `kind` in raw_caption_path would let a bare comparison pass
		// vacuously; pin the concrete shape.
		const rawCap = pyPathRef('raw_caption_path', { media_id: ID, kind: 'captions', ext: 'vtt' });
		expect(rawCap).toMatch(/^derived\/captions\/captions\/.+\.captions\..+$/);
	});
});

/**
 * The SILENCE FLOOR is the same physical constant declared TWICE, on opposite sides of a process
 * boundary, with nothing checking that the two numbers agree.
 *
 *  - core `src/lib/server/media/loudness.ts` — `SILENCE_FLOOR_DB = -90`, compared against a
 *    measured `maxDb` in `isDigitalSilence`.
 *  - worker `worker/src/processor.py` — `SILENCE_FLOOR_DB = -90.0`, compared against a measured
 *    `max_volume_db` in `is_silent`.
 *
 * Both answer ONE question: does this separated vocals stem count as digital silence? So a drift is a
 * DISAGREEMENT ABOUT REALITY, not a cosmetic mismatch, and it is silent in both directions. Raise the
 * worker's floor alone and the worker withholds a stem the core would happily link — the guiding track
 * is simply never reported and the singer's control does nothing, which is indistinguishable from a
 * working guide until they turn it up. Raise the CORE's floor alone and the core refuses a stem the
 * worker measured as fine, so a healthy vocals file sits on disk unreferenced and `vocals-backfill.ts`
 * cannot rescue it because the core is the thing rejecting it.
 *
 * Neither suite can see the other: the worker's pytest asserts against its own constant and the core's
 * bun test asserts against its own, so both stay green on any drift — the identical blind spot that let
 * `songProfile` ship at the wrong envelope level and `VOCALS_EXT` sit unguarded above.
 *
 * Guard it the way every check in this file does: read the Python as TEXT (no interpreter, runs in the
 * ordinary `bun test` gate) and compare it against the IMPORTED core constant. Comparing the imported
 * value rather than a second scrape is deliberate and is the pattern the keepalive and stem-extension
 * blocks already use — a scrape of the TS side would still pass if the literal stayed put while the
 * exported value stopped being it.
 *
 * The two literals are written differently on purpose (`-90` reads as an int in TS, `-90.0` keeps the
 * Python constant a float so `max_volume_db <= SILENCE_FLOOR_DB` never mixes types), so the comparison
 * is NUMERIC. A string compare would red on a correct tree, which is the fastest way to get a guard
 * deleted.
 */
describe('silence floor parity (worker processor.py vs core loudness.ts)', () => {
	const SILENCE_REL = 'processor.py';
	const silencePath = join(WORKER_SRC, SILENCE_REL);
	const silencePy = readFileSync(silencePath, 'utf8');

	/**
	 * The worker's effective `SILENCE_FLOOR_DB`, read as text.
	 *
	 * Anchored at column 0 (`^` under `m`) so a `#:`-commented line — and this constant HAS two doc
	 * comment lines directly above it that name it — cannot be the match. Takes the LAST such
	 * assignment, not the first, because Python's effective value is the last one executed: a
	 * triple-quoted string or a dead earlier assignment carrying a different number above the real one
	 * would otherwise shadow it and hide exactly the drift this guard exists to catch.
	 */
	function pyFloorDb(): number | null {
		const ms = [...silencePy.matchAll(/^SILENCE_FLOOR_DB\s*=\s*(-?\d+(?:\.\d+)?)/gm)];
		const last = ms[ms.length - 1];
		return last ? Number(last[1]) : null;
	}

	test('processor.py is where the silence-floor read expects it', () => {
		expect(existsSync(silencePath), `${SILENCE_REL} not found under ${WORKER_SRC} — did the module move?`).toBe(true);
	});

	test('the worker floor is present and parses as a finite number', () => {
		// NON-VACUITY. This is the arm that makes the parity assertion below load-bearing: an extraction
		// that silently found nothing would compare `null` against the core value, and while THAT
		// particular shape reds, a future regex slip returning `0` or `NaN` would not necessarily. Pin
		// that a real number was read, so the guard cannot degrade into comparing a parse failure.
		const py = pyFloorDb();
		expect(
			py,
			`SILENCE_FLOOR_DB not found at module level in ${SILENCE_REL} — did the constant move or get commented out?`
		).not.toBeNull();
		expect(Number.isFinite(py!)).toBe(true);
		// It is a dBFS floor: negative, and in the neighbourhood a 16-bit silence measurement lives in.
		// A regex that started matching some unrelated number would clear the finite check but not this.
		expect(py!).toBeLessThan(0);
		expect(py!).toBeGreaterThan(-200);
	});

	test('the silence floor agrees across the seam', () => {
		// NUMERIC comparison: the core writes -90 and the worker -90.0, which are the same floor. The
		// only thing that may differ between the two sides is how the literal is spelled.
		expect(pyFloorDb()).toBe(SILENCE_FLOOR_DB);
	});

	test('both sides still COMPARE against the floor, so the constant is not merely declared', () => {
		// A parity check on a constant nothing reads is bookkeeping. Pin that each side's silence verdict
		// is still derived from its own floor — if a comparison is inlined to a bare literal, the two
		// numbers can stay in agreement while the code stops using them.
		expect(silencePy).toMatch(/max_volume_db\s*<=\s*SILENCE_FLOOR_DB/);
		const loudnessTs = readFileSync(at('src/lib/server/media/loudness.ts'), 'utf8');
		expect(loudnessTs).toMatch(/maxDb\s*<=\s*SILENCE_FLOOR_DB/);
	});
});

/**
 * The DEMUCS_MODELS WHITELIST is the roformer table's twin, and until now the ONLY half of the
 * separator contract with no guard.
 *
 * `demucs.py` carries `DEMUCS_MODELS = ("htdemucs", ...)` under a comment that says it "Mirrors the
 * `demucs` engine's model whitelist in packages/shared/src/lyrics/separators.ts" — but nothing enforced the
 * mirror. Its roformer twin IS guarded (the token↔checkpoint block above reads ROFORMER_MODELS as
 * text and pins it against the offered set); the demucs side lived only in that prose comment.
 *
 * The drift this stops is concrete: add a fourth checkpoint to `separators.ts` and it becomes
 * selectable in room settings, but the worker's `resolve_demucs_model` rejects any id not in
 * DEMUCS_MODELS. The core validated the engine+model pairing against `separators.ts` before
 * enqueueing, so every process of that song then hits `demucs.py`'s `ValueError` — a permanent config
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
		// (offered ⊄ worker) parks every process of it on a non-retryable ValueError; a worker checkpoint
		// no UI offers (worker ⊄ offered) is dead config that drifts unnoticed.
		expect([...worker].sort()).toEqual([...offered].sort());
	});

	test('demucs.py is where the whitelist read expects it', () => {
		const path = join(WORKER_SRC, 'separation/demucs.py');
		expect(existsSync(path), `demucs.py not found under ${WORKER_SRC} — did the module move?`).toBe(true);
	});
});

/**
 * The songProfile's INNER FIELDS are a third hand-mirrored contract, and until now nothing spanned it.
 *
 * The guard above proves `songProfile` arrives at the right LEVEL of the artifacts envelope. It says
 * nothing about what is inside it — and the inside is written in Python (`_NULL_PROFILE` in
 * `analysis/song_profile.py`, the one place the always-publish null shape is built) and read in
 * TypeScript (`SongProfile` + `EMPTY_SONG_PROFILE` + `normalizeSongProfile` in
 * `packages/shared/src/process/song-profile.ts`). There is no generator between them. The worker's pytest
 * asserts its own dict, the shared package's bun test asserts its own literal, and neither has ever
 * seen the other's shape — the identical blind spot that let `songProfile` itself ship at the wrong
 * envelope level.
 *
 * The drift this catches is silent in the direction that matters. Add a measured field on the worker
 * side and forget the TS mirror and `normalizeSongProfile` drops it on the floor at the boundary: the
 * process still completes, the gate is still satisfied, nothing errors, and the measurement is simply
 * never seen — which is exactly how `meanDb` came to be parsed, tested and discarded for a year
 *. Add it on the TS side and forget Python and every song reads null forever.
 *
 * Three-way, because two of the three can agree while the declared type disagrees: the Python source,
 * the TS interface DECLARATION (read as text, since a type is erased at runtime), and the runtime keys
 * of `EMPTY_SONG_PROFILE`.
 */
describe('songProfile inner-field parity (worker dict vs shared type)', () => {
	const SHARED_SONG_PROFILE = at('src/lib/contract/process/song-profile.ts');
	const WORKER_SONG_PROFILE = join(WORKER_SRC, 'analysis/song_profile.py');

	/** Keys of `_NULL_PROFILE = { "name": None, ... }`, read from the Python as text. */
	function pyProfileKeys(): string[] {
		expect(
			existsSync(WORKER_SONG_PROFILE),
			`song_profile.py not found under ${WORKER_SRC} — did the module move?`
		).toBe(true);
		const src = readFileSync(WORKER_SONG_PROFILE, 'utf8');
		const m = src.match(/_NULL_PROFILE\s*=\s*\{([\s\S]*?)\n\}/);
		expect(m, '_NULL_PROFILE dict not found in song_profile.py — did the null shape move?').toBeTruthy();
		return [...m![1]!.matchAll(/^\s*"(\w+)"\s*:/gm)].map((x) => x[1]!);
	}

	/** Top-level field names of `export interface SongProfile { ... }`, read as text. */
	function tsDeclaredKeys(): string[] {
		expect(
			existsSync(SHARED_SONG_PROFILE),
			`song-profile.ts not found at ${SHARED_SONG_PROFILE} — did the module move?`
		).toBe(true);
		const src = readFileSync(SHARED_SONG_PROFILE, 'utf8');
		const m = src.match(/export interface SongProfile \{([\s\S]*?)\n\}/);
		expect(m, 'SongProfile interface not found in song-profile.ts').toBeTruthy();
		// Field lines only: doc-comment lines inside the body start with `*` or `/`, never an ident.
		return [...m![1]!.matchAll(/^\t([A-Za-z_]\w*)\??:/gm)].map((x) => x[1]!);
	}

	test('the Python null profile and the TS interface declare exactly the same fields', () => {
		const py = pyProfileKeys();
		const ts = tsDeclaredKeys();
		// Non-vacuity floor on BOTH sides: an empty parse from either regex would let the equality
		// pass with nothing in it, which is the trap the guards above call out by name.
		expect(py.length, '_NULL_PROFILE parsed empty — did the dict change shape?').toBeGreaterThan(0);
		expect(ts.length, 'SongProfile parsed empty — did the interface change shape?').toBeGreaterThan(0);
		expect([...py].sort()).toEqual([...ts].sort());
	});

	test('EMPTY_SONG_PROFILE carries every declared field at runtime, and no extras', () => {
		// The declaration is erased at runtime, so a field can be declared and missing from the
		// always-publish literal the gate depends on. This is the arm that catches that.
		expect([...Object.keys(EMPTY_SONG_PROFILE)].sort()).toEqual([...tsDeclaredKeys()].sort());
	});

	test('normalizeSongProfile emits every declared field even from garbage input', () => {
		// The boundary must not narrow the shape: a field it forgets to copy is a measurement that
		// silently never arrives, whatever both sides declare.
		expect([...Object.keys(normalizeSongProfile({ nonsense: true }))].sort()).toEqual([...tsDeclaredKeys()].sort());
	});

	test('the measured loudness level crosses the wire under one name on both sides', () => {
		// Named explicitly, not just covered by the set equality above: this is the field adds,
		// and a set-equality guard stays green if BOTH sides are renamed to something the playback
		// side does not read.
		expect(pyProfileKeys()).toContain('loudnessLufs');
		expect(tsDeclaredKeys()).toContain('loudnessLufs');
	});
});
