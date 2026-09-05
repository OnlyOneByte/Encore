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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASR_MODELS, SYNC_MODES, SEPARATOR_ENGINES, FETCHERS } from '@encore/shared';

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
		expect(pyEnumValues(vocabulary, 'Engine').sort()).toEqual(
			SEPARATOR_ENGINES.map((e) => e.id).sort()
		);
	});

	test('fetchers match the worker Fetcher enum', () => {
		expect(pyEnumValues(vocabulary, 'Fetcher').sort()).toEqual(FETCHERS.map((f) => f.id).sort());
	});

	// vocabulary.py is read once at module load; if it ever moves, that read throws a bare ENOENT and
	// every parity test above fails for the wrong reason. Assert its presence loudly, the same way the
	// artifact-envelope block guards its per-file reads, so a moved file names itself.
	test('vocabulary.py is where the parity reads expect it', () => {
		const path = join(WORKER_SRC, 'vocabulary.py');
		expect(existsSync(path), `vocabulary.py not found under ${WORKER_SRC} — did the module move?`).toBe(
			true
		);
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
		const tsMediaStatuses = [
			'queued',
			'downloading',
			'separating',
			'aligning',
			'ready',
			'failed',
			'canceled'
		] as const;
		const _exhaustive: readonly import('@encore/shared').MediaStatus[] = tsMediaStatuses;
		void _exhaustive;
		const stages = pyEnumValues(vocabulary, 'Stage');
		expect(stages.length).toBeGreaterThan(0); // a silent empty parse would pass vacuously
		expect(stages.filter((s) => !tsMediaStatuses.includes(s as never))).toEqual([]);
	});

	test('protocol.py is where the wire-verb read expects it', () => {
		const path = join(WORKER_SRC, 'protocol.py');
		expect(existsSync(path), `protocol.py not found under ${WORKER_SRC} — did the module move?`).toBe(
			true
		);
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
		const block = roformerPy.match(/ROFORMER_MODELS\s*=\s*\{([\s\S]*?)\n\}/);
		if (!block) throw new Error('ROFORMER_MODELS not found in roformer.py — did the table move?');
		const out: Record<string, string> = {};
		for (const m of block[1]!.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) out[m[1]!] = m[2]!;
		return out;
	}

	test('every roformer model the UI offers resolves to a slug the worker can run', () => {
		const mapped = pyRoformerModels();
		expect(Object.keys(mapped).length).toBeGreaterThan(0);
		const offered = SEPARATOR_ENGINES.filter((e) => e.id === 'roformer').flatMap((e) =>
			e.models.map((m) => m.id)
		);
		expect(offered.length).toBeGreaterThan(0);
		expect(offered.filter((id) => !mapped[id])).toEqual([]);
	});

	test('bs-roformer-1297 still resolves to the KNOWN-MISMATCHED slug, not the benchmarked one', () => {
		// Change this only together with the rtFactor/rank in separators.ts and the comment in
		// roformer.py — the point of the pin is that the three move as one.
		expect(pyRoformerModels()['bs-roformer-1297']).toBe(
			'roformer-model-bs-roformer-sw-by-jarredou'
		);
	});
});
