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
});
