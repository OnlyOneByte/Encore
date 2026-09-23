// guard: every TS↔Python contract the worker hand-mirrors. See docs/GUARDS.md#cross-language-parity.
//
// The worker cannot import $lib/contract, so each shared enum, artifact key, path builder and threshold
// exists twice. Drift is silent — core enqueues a job whose capability no worker advertises and the song
// sits at 0% looking like a hung worker. Every check here reads the Python as TEXT so it needs no
// interpreter and reds inside the ordinary `bun test` gate.
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

// `songProfile` is a SIBLING of `stems` in the artifacts dict. Reading it one level deeper
// (`artifacts.stems.songProfile`) yields undefined, and because the `stems` gate requires the profile to
// be PRESENT every separated song then sits at "Separating vocals" forever with nothing retrying it.
const ARTIFACT_WRITERS = ['steps/separate.py'] as const;

describe('artifact envelope parity (worker yield vs core read)', () => {
	for (const file of ARTIFACT_WRITERS) {
		test(`${file} publishes songProfile as a SIBLING of stems, not inside it`, () => {
			const path = join(WORKER_SRC, file);
			expect(existsSync(path), `${file} not found under ${WORKER_SRC} — did the module move?`).toBe(true);
			const src = readFileSync(path, 'utf8');
			const assigns = [...src.matchAll(/out\.artifacts\[["'](\w+)["']\]\s*=/g)].map((m) => m[1]!);
			expect(assigns).toContain('stems');
			expect(assigns).toContain('songProfile');
			expect(/artifacts\[["']stems["']\]\[["']songProfile["']\]/.test(src)).toBe(false);
		});
	}

	test('core reads it from the top level too — no reaching through stems', () => {
		const raw = readFileSync(at('src/lib/server/jobs/worker-hub.ts'), 'utf8');
		// Comment-stripped: the read site's own comment names the bad path, so an unstripped scan would
		// flag its own explanation. Newlines preserved so nothing else about the file shifts.
		const hub = raw
			.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
			.replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/./g, ' '));
		expect(hub).toContain('artifacts?.songProfile');
		expect(hub).not.toMatch(/artifacts[^\n]*\.stems[^\n]*songProfile/);
	});
});

// An artifact key the worker writes but `JobArtifacts` does not declare is written, undeclared and
// unread — the drift that stalled processes when `songProfile` and a fetch job's `source` key shipped
// undeclared. Covers all `steps/*.py`, not just separate.py.
describe('every worker-written artifact key is declared in JobArtifacts', () => {
	function declaredArtifactKeys(): Set<string> {
		const events = readFileSync(at('src/lib/contract/core/events.ts'), 'utf8');
		const m = events.match(/export interface JobArtifacts \{([\s\S]*?)\n\}/);
		expect(m, 'JobArtifacts interface not found in events.ts').toBeTruthy();
		const body = m![1]!;
		// Single-tab indent only: a nested object's members are deeper and are not top-level keys.
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
	const rest = src.slice(start + 1);
	// The block ends at the next module-level `class `, `def ` or assignment. `def ` is load-bearing:
	// `Capability` is followed by `serves_family`, and without it the block runs on into the next class.
	const endRel = rest.search(/\n(?:class |def |[A-Z_]+(?::[^\n=]+)? =)/);
	const block = endRel === -1 ? rest : rest.slice(0, endRel);
	return [...block.matchAll(/^\s{4}[A-Z][A-Z0-9_]*\s*=\s*"([^"]+)"/gm)].map((m) => m[1]!);
}

/**
 * Frame-name constants from `protocol.py`, for one direction.
 *
 * protocol.py's `# worker -> core` / `# core -> worker` COMMENTS are the section delimiters, so they are
 * load-bearing data here, not prose: delete either one and this throws. Reading the whole file instead
 * would conflate the two unions and let a verb move sides unnoticed.
 */
function pyWireVerbs(section: 'worker -> core' | 'core -> worker'): string[] {
	const start = protocolPy.indexOf(`# ${section}`);
	if (start < 0) throw new Error(`protocol.py has no '# ${section}' section — did the grouping change?`);
	const rest = protocolPy.slice(start + section.length);
	// Stop at the NEXT comment line of any kind, markers included — excluding them merges both directions.
	const end = rest.search(/\n#/);
	const body = end < 0 ? rest : rest.slice(0, end);
	return [...body.matchAll(/^[A-Z_]+ = "([^"]+)"/gm)].map((m) => m[1]!);
}

function pyCapabilityTokens(): string[] {
	// The `Capability` enum is the tokens' single source of truth; the worker's own suite asserts its
	// probes are the same set. An empty extraction would make every routed capability read as "missing"
	// while the assertions below all pass, so it throws rather than returning [].
	const tokens = pyEnumValues(vocabulary, 'Capability');
	if (tokens.length === 0) throw new Error('no Capability members found in vocabulary.py — the extraction broke');
	return tokens;
}

describe('TS↔Python vocabulary parity', () => {
	test('JobType matches the worker Action enum', () => {
		// A bare union has no runtime value to import, so the members are listed and the `_exhaustive`
		// assignment makes TypeScript check the list IS the union — it cannot silently fall behind.
		const tsJobTypes = ['fetch', 'stems', 'stems-upgrade', 'align'] as const;
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

	// vocabulary.py is read at module load, so a move throws a bare ENOENT and every parity test above
	// fails for the wrong reason. This arm makes the moved file name itself.
	test('vocabulary.py is where the parity reads expect it', () => {
		const path = join(WORKER_SRC, 'vocabulary.py');
		expect(existsSync(path), `vocabulary.py not found under ${WORKER_SRC} — did the module move?`).toBe(true);
	});

	test('lyrics text sources match the worker TextSource enum', () => {
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
		// dispatch.ts compares these by raw `capabilities.includes(cap)`, so a typo on either side parks
		// the job forever rather than failing loudly.
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

	// The core routes on `requiredCapability(jobType)`, whose last branch is a bare `return jobType`.
	// `align` and `stems-upgrade` fall through it and appear in neither capability table, so enumerating
	// the tables misses them: rename the worker's `align` probe and every align job parks at 0% with both
	// suites green. Asserting the ROUTED set subsumes both table checks above.
	test('every JobType routes to a capability the worker can advertise', () => {
		const jobTypes = ['fetch', 'stems', 'stems-upgrade', 'align'] as const;
		const _exhaustive: readonly JobType[] = jobTypes;
		void _exhaustive;
		const advertisable = new Set(pyCapabilityTokens());
		// With no settings, requiredCapability returns each type's DEFAULT-routed capability — what the
		// worker must serve out of the box.
		const missing = jobTypes
			.map((jt) => ({ jt, cap: requiredCapability(jt) }))
			.filter(({ cap }) => !advertisable.has(cap));
		expect(missing).toEqual([]);
	});
	// Rename a frame on either side and the worker silently ignores an unrecognised `type` (or the core
	// drops the worker's): a worker that connects, handshakes, then never accepts a job.
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

	// The worker emits `Stage` as `job:progress.stage` and the core rebroadcasts it to phones, so a stage
	// the union lacks renders no label. SUBSET, not equality: `queued`/`ready`/`failed`/`canceled` are
	// core-side states no worker emits.
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

// The roformer token→checkpoint mapping DIVERGES on purpose: `separators.ts` ranks `bs-roformer-1297` on
// numbers measured against a checkpoint the worker does not resolve it to. These tests pin the divergence
// as it is rather than bless it, so repointing the token has to come here and say so.
describe('roformer token ↔ checkpoint identity', () => {
	const roformerPy = readFileSync(join(WORKER_SRC, 'separation/roformer.py'), 'utf8');

	function pyRoformerModels(): Record<string, string> {
		// Column-0 anchored (`^` under `m`): a `#`-commented copy of the table above the live one cannot
		// start at column 0, so it can never be the first match and mask a real divergence.
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
		// Change this only together with the rtFactor/rank in separators.ts: the pin exists so the two move
		// as one.
		expect(pyRoformerModels()['bs-roformer-1297']).toBe('roformer-model-bs-roformer-sw-by-jarredou');
	});
});

// The worker keepalive must stay under HALF the core progress lease, not merely under it, so one dropped
// tick cannot breach. See docs/GUARDS.md#cross-language-parity.
describe('worker ML keepalive stays under the core progress lease', () => {
	const runnerPy = readFileSync(join(WORKER_SRC, 'runtime/runner.py'), 'utf8');
	// Python's effective value is the LAST module-level assignment, so take the last column-0 match: a
	// triple-quoted string carrying an earlier `LEASE_KEEPALIVE_SEC =` must not shadow the real one.
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
		expect(keepaliveMs).toBeLessThan(DEFAULT_LEASE_CONFIG.progressLeaseMs / 2);
	});

	// The `heartbeatIntervalSec` the core advertises is bound by the same half-lease margin, since a worker
	// that honours it paces its progress by it. Recomputed from the DIVISOR LITERALS the source applies, not
	// by re-evaluating its expression, so dropping the `/ 2` reds.
	const hubRaw = readFileSync(at('src/lib/server/jobs/worker-hub.ts'), 'utf8');
	const hubStripped = hubRaw
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/./g, ' '));

	test('core advertises heartbeatIntervalSec derived from progressLeaseMs', () => {
		// Must be a Math.floor over progressLeaseMs and nothing else, so the value tracks the lease instead
		// of being a literal that can desync from it.
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
		const divisors = m![1].match(/\d+/g)!.map(Number);
		expect(divisors.length).toBeGreaterThan(0); // a vacuous parse would divide by nothing
		const advertisedSec = Math.floor(divisors.reduce((acc, d) => acc / d, DEFAULT_LEASE_CONFIG.progressLeaseMs));
		const advertisedMs = advertisedSec * 1000;
		// `<=` because exactly-half is the intended value; advertising the full lease is what reds.
		expect(advertisedMs).toBeLessThanOrEqual(DEFAULT_LEASE_CONFIG.progressLeaseMs / 2);
	});
});

// A stem key mismatch is silent: the file exists, the player 404s, and retention builds a key for a file
// that is not there so eviction never reclaims the disk. See docs/GUARDS.md#cross-language-parity.
describe('stem path/extension parity (worker processor.py vs core paths.ts)', () => {
	const PROCESSOR_REL = 'processor.py';
	const processorPath = join(WORKER_SRC, PROCESSOR_REL);
	const processorPy = readFileSync(processorPath, 'utf8');

	// Run through the real core key builders rather than a re-typed literal, so the reference moves with a
	// change to the builder shape.
	const ID = 'sample-media-id';

	/** A `NAME = "value"` module-level string constant in processor.py, by name. Throws if absent. */
	function pyStrConst(name: string): string {
		const m = new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm').exec(processorPy);
		if (!m) throw new Error(`${name} not found as a module-level string in ${PROCESSOR_REL}`);
		return m[1]!;
	}

	/**
	 * The relative ref a `*_path` builder produces for ID, reconstructed from its `os.path.join(...)` call
	 * as TEXT, never executed. `media_dir` is the caller's volume root and is NOT part of the wire ref, so
	 * it is dropped; every other segment is a literal or an f-string this expands. An unrecognised segment
	 * shape throws rather than returning a half-parsed ref.
	 */
	function pyPathRef(fnName: string, subs: Record<string, string>): string {
		const fn = new RegExp(`def ${fnName}\\([^)]*\\)[^:]*:([\\s\\S]*?)\\n(?:def |[A-Za-z@#])`, 'm').exec(
			processorPy + '\ndef '
		);
		if (!fn) throw new Error(`def ${fnName} not found in ${PROCESSOR_REL}`);
		// GREEDY to the last `)` on the line: a non-greedy match stops at the inner `)` of a call like
		// `ext.lstrip('.')` and truncates the arg list.
		const retLine = /return\s+os\.path\.join\(([\s\S]*)\)\s*$/m.exec(fn[1]!);
		if (!retLine) throw new Error(`${fnName} does not end in os.path.join(...) — shape changed?`);
		const joinCall = retLine;
		const args = joinCall[1]!
			.split(',')
			.map((a) => a.trim())
			.filter((a) => a.length > 0);
		if (args[0] !== 'media_dir') throw new Error(`${fnName} does not join under media_dir first`);
		const segs = args.slice(1).map((a) => {
			const lit = /^"([^"]*)"$/.exec(a);
			if (lit) return lit[1]!;
			// A bare identifier is a runtime argument (e.g. `kind` in raw_caption_path), resolved from subs.
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) {
				if (a in subs) return subs[a]!;
				throw new Error(`${fnName}: bare segment ${a} has no value in subs`);
			}
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
		// The mix is what the TV plays as MASTER on a mix song, so a key mismatch is a 404 on the file the
		// room is trying to play — `guidePath` has already committed to the mix path by then.
		const worker = pyPathRef('guide_mix_path', {
			media_id: ID,
			GUIDE_MIX_EXT: pyStrConst('GUIDE_MIX_EXT')
		});
		expect(worker).toBe(guideMixKey(ID));
		// Shape as well as equality: '' === '' on a double parse miss would pass.
		expect(worker).toMatch(/^derived\/stems\/.+-guidemix\..+$/);
	});

	test('the raw source-audio key agrees byte-for-byte', () => {
		const worker = pyPathRef('source_audio_path', { media_id: ID, ext: 'wav' });
		expect(worker).toBe(audioKey(ID, 'wav'));
	});

	test('the retained raw caption key agrees byte-for-byte', () => {
		// retention.ts enumerates this key per (kind, ext) to count and evict the retained track, so both
		// kinds and both known exts are checked.
		for (const kind of ['captions', 'auto-captions']) {
			for (const ext of ['vtt', 'srt']) {
				const worker = pyPathRef('raw_caption_path', { media_id: ID, kind, ext });
				expect(worker).toBe(rawCaptionKey(ID, kind, ext));
			}
		}
	});

	test('non-vacuity: the extracted keys are non-empty, stem-shaped derived refs', () => {
		// Pins the concrete shape, so a renamed fn or changed join cannot degrade this into '' === ''.
		const ins = pyPathRef('instrumental_path', {
			media_id: ID,
			INSTRUMENTAL_EXT: pyStrConst('INSTRUMENTAL_EXT')
		});
		const voc = pyPathRef('vocals_path', { media_id: ID, VOCALS_EXT: pyStrConst('VOCALS_EXT') });
		expect(ins).toMatch(/^derived\/stems\/.+-instrumental\..+$/);
		expect(voc).toMatch(/^derived\/stems\/.+-vocals\..+$/);
		expect(pyStrConst('INSTRUMENTAL_EXT').length).toBeGreaterThan(0);
		expect(pyStrConst('VOCALS_EXT').length).toBeGreaterThan(0);
		const rawCap = pyPathRef('raw_caption_path', { media_id: ID, kind: 'captions', ext: 'vtt' });
		expect(rawCap).toMatch(/^derived\/captions\/captions\/.+\.captions\..+$/);
	});
});

// One physical constant declared on both sides, answering "is this vocals stem digital silence?". The
// comparison is NUMERIC because the literals are spelled differently on purpose (`-90.0` keeps the Python
// side a float so its `<=` never mixes types), so a string compare would red on a correct tree.
// See docs/GUARDS.md#cross-language-parity.
describe('silence floor parity (worker processor.py vs core loudness.ts)', () => {
	const SILENCE_REL = 'processor.py';
	const silencePath = join(WORKER_SRC, SILENCE_REL);
	const silencePy = readFileSync(silencePath, 'utf8');

	/**
	 * The worker's effective `SILENCE_FLOOR_DB`, read as text. Column-0 anchored so the `#:` doc lines
	 * directly above the constant cannot be the match, and LAST-match because Python's effective value is
	 * the last assignment executed.
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
		// Makes the parity assertion below load-bearing: a regex slip returning 0 or NaN would not
		// necessarily red there, so pin that a real number was read.
		const py = pyFloorDb();
		expect(
			py,
			`SILENCE_FLOOR_DB not found at module level in ${SILENCE_REL} — did the constant move or get commented out?`
		).not.toBeNull();
		expect(Number.isFinite(py!)).toBe(true);
		// A dBFS floor: negative, and in the range a 16-bit silence measurement lives in. A regex that
		// started matching an unrelated number would clear the finite check but not these.
		expect(py!).toBeLessThan(0);
		expect(py!).toBeGreaterThan(-200);
	});

	test('the silence floor agrees across the seam', () => {
		expect(pyFloorDb()).toBe(SILENCE_FLOOR_DB);
	});

	test('both sides still COMPARE against the floor, so the constant is not merely declared', () => {
		// Inline either comparison to a bare literal and the two numbers stay in agreement while the code
		// stops reading them — a parity check on a constant nothing reads is bookkeeping.
		expect(silencePy).toMatch(/max_volume_db\s*<=\s*SILENCE_FLOOR_DB/);
		const loudnessTs = readFileSync(at('src/lib/server/media/loudness.ts'), 'utf8');
		expect(loudnessTs).toMatch(/maxDb\s*<=\s*SILENCE_FLOOR_DB/);
	});
});

// Add a checkpoint to separators.ts alone and it becomes selectable, the core validates the pairing against
// separators.ts and enqueues, then `resolve_demucs_model` raises — a permanent config error no retry can fix.
describe('demucs model whitelist parity (worker DEMUCS_MODELS ↔ separators.ts)', () => {
	const demucsPy = readFileSync(join(WORKER_SRC, 'separation/demucs.py'), 'utf8');

	/** The ids in `DEMUCS_MODELS = ("a", "b", ...)`, read from demucs.py as text. */
	function pyDemucsModels(): string[] {
		// Column-0 anchored: unanchored, a commented-out CORRECT tuple parked above a live wrong one would
		// be the first match and grant a false exemption on the exact drift this catches.
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
		expect(worker.length, 'DEMUCS_MODELS parsed empty from demucs.py — did the tuple change shape?').toBeGreaterThan(0);
		expect(
			offered.length,
			'the demucs engine offers no models in separators.ts — did the registry move?'
		).toBeGreaterThan(0);
		// Equality, not subset, in BOTH directions: offered ⊄ worker parks every process on a non-retryable
		// ValueError, worker ⊄ offered is dead config that drifts unnoticed.
		expect([...worker].sort()).toEqual([...offered].sort());
	});

	test('demucs.py is where the whitelist read expects it', () => {
		const path = join(WORKER_SRC, 'separation/demucs.py');
		expect(existsSync(path), `demucs.py not found under ${WORKER_SRC} — did the module move?`).toBe(true);
	});
});

// Add a songProfile field on the worker side only and `normalizeSongProfile` drops it at the boundary: the
// process completes, the gate is satisfied, and the measurement is never seen. THREE-way, because the Python
// dict and the runtime literal can agree while the erased type declaration disagrees.
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
		return [...m![1]!.matchAll(/^\t([A-Za-z_]\w*)\??:/gm)].map((x) => x[1]!);
	}

	test('the Python null profile and the TS interface declare exactly the same fields', () => {
		const py = pyProfileKeys();
		const ts = tsDeclaredKeys();
		expect(py.length, '_NULL_PROFILE parsed empty — did the dict change shape?').toBeGreaterThan(0);
		expect(ts.length, 'SongProfile parsed empty — did the interface change shape?').toBeGreaterThan(0);
		expect([...py].sort()).toEqual([...ts].sort());
	});

	test('EMPTY_SONG_PROFILE carries every declared field at runtime, and no extras', () => {
		// The declaration is erased at runtime, so a field can be declared and still missing from the
		// always-publish literal the gate depends on.
		expect([...Object.keys(EMPTY_SONG_PROFILE)].sort()).toEqual([...tsDeclaredKeys()].sort());
	});

	test('normalizeSongProfile emits every declared field even from garbage input', () => {
		expect([...Object.keys(normalizeSongProfile({ nonsense: true }))].sort()).toEqual([...tsDeclaredKeys()].sort());
	});

	test('the measured loudness level crosses the wire under one name on both sides', () => {
		// Named explicitly because the set equality above stays green if BOTH sides are renamed to something
		// the playback side does not read.
		expect(pyProfileKeys()).toContain('loudnessLufs');
		expect(tsDeclaredKeys()).toContain('loudnessLufs');
	});
});
