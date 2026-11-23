// The fake WORKERS: domain actors that make processing really happen on a box with no torch, no demucs, no
// whisperx and an ffmpeg that may only decode. They dial home over the real worker WebSocket protocol, claim
// real jobs, and publish REAL AUDIO emitted by world/audio.ts — so a spec drives the whole core-side path
// (dispatch → accept → progress → publish → markMediaReady → queue:sync → TV loads → sound comes out) and
// skips only what this box cannot do. They prove nothing about separation quality, alignment accuracy, or
// whether yt-dlp can still reach YouTube.
//
// Ported from tests/e2e/fake-stems-worker.mjs (the worker that does the job) and
// tests/e2e/fake-align-worker.mjs (the observer that reads `params` off the wire and claims nothing).
//
// IN-PROCESS, where the old pair were spawned children handed an `EPORT`. Nothing in the protocol depends on
// process identity: the auth token is a query param, `EPORT` only told the child which core to dial, and the
// hub keys a session by the `workerId` carried on the socket. Running here instead buys three things — the
// fault flags become typed options rather than env strings, the assign record and the log are readable
// directly rather than by tailing a file (the old probes had to poll a LOG FILE because a buried stdout
// listener on the child was enough to kill its WS), and teardown is one close frame rather than a
// process-group kill.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
// `ws`, not Node's global WebSocket: a token mismatch comes back as a 401 HTTP response to the UPGRADE, and
// only `ws` surfaces it (`unexpected-response`) with a status code. On the global it is an opaque error event,
// which is how "the worker never welcomed" gets misread as a hung core.
import { WebSocket } from 'ws';
import { silence, tone } from './audio';
import type { Core } from './core';
import type { World } from './fixtures';
import type { JobArtifacts, JobParams, JobType, MediaStatus, WorkerCommand, WorkerMessage } from '$lib/contract';

/** Only the parts of the world a worker needs; `core` is here so a failure can name core's own output. */
export type WorkerWorld = Pick<World, 'baseURL' | 'mediaDir'> & { core: Pick<Core, 'log'> };

/** The env-configurable storage classes from src/lib/server/media/paths.ts. `work` is deliberately not
 *  configurable there, and nothing this worker writes lands in it. */
export type StorageClass = 'audio' | 'derived' | 'meta';

/**
 * The fault injectors, one per row of docs/E2E.md#fault-injection. Each reaches a SPECIFIC real state, so the
 * meanings are carried over verbatim from the env vars they replace — renaming one is fine, re-aiming it is not.
 */
export interface FakeWorkerFaults {
	/** `FAKE_SILENT_INSTRUMENTAL`: floor-level instrumental — the guard must refuse to publish it. */
	silentInstrumental?: boolean;
	/** `FAKE_SILENT_VOCALS`: floor-level vocals — must NOT fail the process; the guide track is optional. */
	silentVocals?: boolean;
	/** `FAKE_SKIP_WRITE`: report every ref but write no file at all — the unservable path. */
	skipWrite?: boolean;
	/** `FAKE_NO_PROFILE`: complete with no `songProfile` — the stems gate must not deadlock. */
	noProfile?: boolean;
	/** `FAKE_FAIL=<jobType>`: fail that job type instead of completing it. */
	fail?: JobType;
	/**
	 * Accept that job type, send one progress frame, then go quiet with the socket still open: what a worker
	 * does once its keepalive ceiling has passed on a step nothing could kill. Core's lease reaper is then the
	 * only thing that can end the job.
	 */
	hang?: JobType;
	/**
	 * Also send `pct: 0` for the current stage every this many ms, between the real figures: the frame order
	 * a worker's timer keepalive produced before it repeated the last figure. Core must never let it pull the
	 * bar back.
	 */
	keepaliveMs?: number;
	/** Report the stems engine and model the job asked for, rather than `fake-separator`: what the ETA's
	 *  history is matched on, so a spec watching the ETA needs it. */
	ranAsAsked?: boolean;
	/** `FAKE_SLOW_MS`: dwell between progress frames, to watch the processing UI. Default 120. */
	slowMs?: number;
	/**
	 * `FAKE_NO_VOCALS`: report no vocals ref at all. A REAL STATE, NOT A FAULT — a worker that could not
	 * encode vocals reports none and the song stays playable. This is NOT what disables the guiding track.
	 */
	noVocals?: boolean;
	/**
	 * `FAKE_GUIDE_MIX`: publish the guide MIX. `hasGuidingTrack()` reads `guideMixRef`, not the vocals stem,
	 * and this worker publishes no mix by default — so this is the ONLY way to reach the ENABLED arm of the
	 * guiding-track slider. Opt-in, because switching it on by default would silently change which arm every
	 * existing spec exercises.
	 */
	guideMix?: boolean;
	/**
	 * The `songProfile.loudnessLufs` every stems job reports. Default `null`, which is NOT a measurement — so by
	 * default nothing this worker publishes enters the library loudness median. A spec whose subject is loudness
	 * normalization sets it, and swaps workers to give different songs different levels.
	 */
	loudnessLufs?: number | null;
}

export interface FakeWorkerOptions extends FakeWorkerFaults {
	/** Unique per connected worker: the hub keys its session map by this, so two workers sharing an id
	 *  replace each other's socket. Defaults to a per-call counter. */
	workerId?: string;
	/**
	 * What the worker ADVERTISES, which dispatch routes by. The default is a full worker's (a bare `fetch` routes
	 * nothing); an uploads-only box is `['stems', 'align']`, a roformer-capped room needs `stems:roformer`.
	 */
	capabilities?: string[];
	concurrency?: number;
	/** Matches `ENCORE_WORKER_TOKEN` on core. Omit it unless the spec booted core WITH one — core refuses a
	 *  role=worker upgrade with 401 when the token is set and the query param does not match. */
	token?: string;
	/**
	 * CLAIM: 'all' is the working worker; 'none' is the align observer — it advertises and records every
	 * `job:assign` but never sends `job:accept`, so the job's ack lease expires after ~10s and requeues with
	 * its attempts unchanged. That is the whole point: the frame's `params` are computed at ASSIGN time, so
	 * an observer reads what a settings change did to work that was already queued.
	 */
	claim?: 'all' | 'none';
	/** Length of every audio file this worker writes (fetch, stems, guide mix). Default 8, the fixture's. A spec
	 *  playing a longer library track sets it to match, or the TV ends the song when the 8 s stem does. */
	seconds?: number;
	/** Real-length lyric lines: six words, about 35 characters, as wide as a sung line on the TV. The default is one
	 *  word a line, which no card or chrome can ever overlap, so a spec checking text against text needs this. */
	longLyricLines?: boolean;
	/** Overrides `MEDIA_DIR`. Defaults to the world's, which is what core was booted with. */
	mediaDir?: string;
	/**
	 * Per-class roots, for a spec that booted core with `ENCORE_AUDIO_DIR`/`ENCORE_DERIVED_DIR`/
	 * `ENCORE_META_DIR` of its own. Otherwise they are read from this process's env exactly as paths.ts reads
	 * them — core inherits that env, so the two agree by construction and only an explicit per-core override
	 * can split them.
	 */
	storageDirs?: Partial<Record<StorageClass, string>>;
}

/** A `job:assign` frame as the worker saw it. */
export interface AssignedJob {
	jobId: string;
	processingId: string;
	mediaId: string;
	jobType: JobType;
	sourceUri: string;
	params: JobParams;
}

export interface FakeWorker {
	readonly workerId: string;
	/** Every assign this worker has seen, oldest first. */
	readonly assigns: readonly AssignedJob[];
	/**
	 * The EARLIEST matching assign, recorded or future — so a spec that calls this after the frame already
	 * landed still gets it, and two calls with the same filter get the same job. Replaces the old align
	 * worker's "NO ASSIGN within 15s"; THROWS on the deadline with what it did see.
	 */
	awaitAssign(filter?: { jobType?: JobType; mediaId?: string; timeout?: number }): Promise<AssignedJob>;
	/** Everything this worker would have printed. Name it in an assertion message, as with `core.log()`. */
	log(): string;
	stop(): Promise<void>;
}

/** The old worker's default, comfortably inside the 15s the welcome advertises (half the 30s progress
 *  lease). Nothing here reads the welcome back, so this number stands alone. */
const HEARTBEAT_MS = 5_000;
const DEFAULT_SLOW_MS = 120;
const WELCOME_TIMEOUT_MS = 15_000;
const DEFAULT_ASSIGN_TIMEOUT_MS = 15_000;

let seq = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Connect a worker that claims real `fetch`/`stems`/`align` jobs and publishes real audio.
 *
 * Resolves once core has WELCOMED it, which is the only signal that proves the hub registered the session —
 * and it THROWS rather than skipping if that never arrives. Same ruling as world/core.ts: a permanently
 * skipped test is indistinguishable from the rot it was meant to catch, so an environment that cannot answer
 * must be loud.
 */
export async function startFakeWorker(world: WorkerWorld, options: FakeWorkerOptions = {}): Promise<FakeWorker> {
	const {
		workerId = `fake-worker-${++seq}`,
		capabilities = ['fetch:ytdlp', 'stems', 'align'],
		concurrency = 1,
		token,
		claim = 'all',
		mediaDir = world.mediaDir,
		storageDirs = {},
		slowMs = DEFAULT_SLOW_MS,
		fail,
		hang,
		keepaliveMs,
		ranAsAsked = false,
		silentInstrumental = false,
		silentVocals = false,
		skipWrite = false,
		noProfile = false,
		noVocals = false,
		guideMix = false,
		loudnessLufs = null,
		seconds = 8,
		longLyricLines = false
	} = options;

	let output = '';
	const log = (...parts: unknown[]) => {
		output += `[${workerId}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
	};

	// Storage classes may each be pointed at their own volume, so mirror paths.ts rather than assuming
	// everything sits under MEDIA_DIR — otherwise the worker writes where core will not look.
	const mediaRoot = resolve(mediaDir);
	const ENV_BY_CLASS: Record<StorageClass, string> = {
		audio: 'ENCORE_AUDIO_DIR',
		derived: 'ENCORE_DERIVED_DIR',
		meta: 'ENCORE_META_DIR'
	};
	const classDir = (cls: string): string => {
		const declared = storageDirs[cls as StorageClass];
		if (declared) return resolve(declared);
		const env = ENV_BY_CLASS[cls as StorageClass];
		const fromEnv = env ? process.env[env]?.trim() : undefined;
		return fromEnv ? resolve(fromEnv) : join(mediaRoot, cls);
	};

	/** Write bytes for a relative ref like "derived/stems/<id>-instrumental.wav". */
	const writeRef = (ref: string, bytes: Uint8Array): void => {
		const [head, ...rest] = ref.split('/');
		const abs = join(classDir(head ?? ''), rest.join('/'));
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, bytes);
		log(`wrote ${ref} (${(bytes.length / 1024).toFixed(0)} KB)`);
	};

	const assigns: AssignedJob[] = [];
	const waiters: { match: (job: AssignedJob) => boolean; resolve: (job: AssignedJob) => void }[] = [];
	let welcomed = false;
	let stopped = false;
	let upgradeFailure: string | null = null;

	const query = new URLSearchParams({ role: 'worker' });
	if (token) query.set('token', token);
	const ws = new WebSocket(`${world.baseURL.replace(/^http/, 'ws')}/ws?${query}`);

	/** A spec stops a worker MID-JOB on purpose (that is the dead-worker case), so a send racing the close
	 *  must be dropped rather than rejected into the test. */
	const send = (msg: WorkerMessage): void => {
		if (stopped || ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify(msg));
	};

	const record = (job: AssignedJob): void => {
		assigns.push(job);
		for (const waiter of waiters.splice(0)) {
			if (waiter.match(job)) waiter.resolve(job);
			else waiters.push(waiter);
		}
	};

	const onAssign = async (job: AssignedJob): Promise<void> => {
		const { jobId, mediaId, jobType, sourceUri, params } = job;
		log(`assigned ${jobType} job=${jobId} media=${mediaId} src=${sourceUri} params=${JSON.stringify(params)}`);
		record(job);
		if (claim === 'none') return;
		// FIRST, before any other frame: accept converts the ack lease into a progress lease. A worker that
		// works for 10s and only then reports is reaped as never having started.
		send({ type: 'job:accept', workerId, jobId });

		if (fail && fail === jobType) {
			await sleep(slowMs);
			log(`failing ${jobType} on purpose`);
			send({ type: 'job:failed', workerId, jobId, error: `injected failure for ${jobType}`, retryable: false });
			return;
		}

		if (hang && hang === jobType) {
			const stage: MediaStatus = jobType === 'fetch' ? 'downloading' : 'separating';
			send({ type: 'job:progress', workerId, jobId, stage, pct: 20 });
			log(`hanging ${jobType} job=${jobId} on purpose`);
			// With `keepaliveMs`, a step that is slow rather than dead: its keepalive goes on, nothing else does.
			if (keepaliveMs) {
				const beat = setInterval(() => {
					if (stopped) clearInterval(beat);
					else send({ type: 'job:progress', workerId, jobId, stage, pct: 20 });
				}, keepaliveMs);
			}
			return;
		}

		// Progress frames drive the phone's processing bar and refresh the lease, so send real ones.
		let stageNow: MediaStatus | null = null;
		const progress = async (stage: MediaStatus, pct: number): Promise<void> => {
			stageNow = stage;
			send({ type: 'job:progress', workerId, jobId, stage, pct });
			await sleep(slowMs);
		};
		// An older worker's timer keepalive: pct 0 for the current stage, between the real figures.
		const keeper = keepaliveMs
			? setInterval(() => {
					if (stageNow) send({ type: 'job:progress', workerId, jobId, stage: stageNow, pct: 0 });
				}, keepaliveMs)
			: undefined;

		try {
			if (jobType === 'fetch') {
				await progress('downloading', 40);
				const ref = `audio/${mediaId}.wav`;
				if (!skipWrite) writeRef(ref, tone({ seconds, hz: [196, 246.94, 293.66] }));
				await progress('downloading', 100);
				send({
					type: 'job:complete',
					workerId,
					jobId,
					mediaUri: ref,
					facts: { engine: 'fake-fetch' },
					stages: [{ stage: 'download', ms: slowMs }]
				});
				return;
			}

			if (jobType === 'stems' || jobType === 'stems-upgrade') {
				await progress('separating', 25);
				// .wav rather than the flac/m4a the real policy names: the key helpers take an explicit ext and
				// the media route maps wav → audio/wav, so this is a legal ref a browser can play.
				const insRef = `derived/stems/${mediaId}-instrumental.wav`;
				const vocRef = `derived/stems/${mediaId}-vocals.wav`;
				const mixRef = `derived/stems/${mediaId}-guide.wav`;
				if (!skipWrite) {
					writeRef(insRef, silentInstrumental ? silence() : tone({ seconds, hz: [220, 277.18, 329.63] }));
					// noVocals writes no vocals file, because it reports no vocals ref either.
					if (!noVocals) {
						writeRef(vocRef, silentVocals ? silence() : tone({ seconds, hz: [440], amp: 0.2 }));
					}
					// A real file so the media route can serve it, but the CHANNEL COUNT is a lie — this writes the
					// same 1-channel tone as the stems. Sufficient because every gate that reads it tests only the
					// ref's PRESENCE; a spec needing real 4-channel audio needs the real worker.
					if (guideMix) writeRef(mixRef, tone({ seconds, hz: [220, 440], amp: 0.3 }));
				}
				await progress('separating', 90);
				const stems: NonNullable<JobArtifacts['stems']> = { instrumental: insRef };
				if (!noVocals) stems.vocals = vocRef;
				// OPT-IN, and only alongside vocals: a guide mix is what makes a song GUIDABLE.
				if (guideMix && !noVocals) stems.guideMix = mixRef;
				const artifacts: JobArtifacts = { stems };
				// songProfile is a SIBLING of stems, never a member, or every process stalls at "Separating
				// vocals" forever. FIELD NAMES matter as much as placement: `normalizeSongProfile` silently
				// discards anything else down to keyTonic:null, which leaves the TV's key line unrendered and
				// reads as a key-shift defect. keyTonic is a PitchClass (0=C … 9=A); the range is MIDI note
				// numbers, not hertz.
				if (!noProfile) {
					artifacts.songProfile = {
						keyTonic: 9, // A
						keyMode: 'minor', // the fixture chord is A/C#/E-ish — call it A minor
						keyConfidence: 0.82,
						lowMidi: 50,
						highMidi: 69, // the vocals fixture is a 440 Hz tone = A4 = MIDI 69
						p05Midi: 55,
						p95Midi: 67,
						histogram: Array.from({ length: 20 }, (_, i) => Math.round(Math.sin((i / 19) * Math.PI) * 40) / 10),
						// `null` by default, where the old worker omitted the key. Identical on the wire as far as core
						// is concerned — `normalizeSongProfile` reads an absent one as null — and stated here so the
						// fixture cannot be mistaken for a loudness MEASUREMENT unless a spec asks for one.
						loudnessLufs
					};
				}
				send({
					type: 'job:complete',
					workerId,
					jobId,
					mediaUri: insRef,
					artifacts,
					facts: {
						// `ranAsAsked`: report the engine and model the job named, as a real separator does.
						engine: ranAsAsked ? params.engine : 'fake-separator',
						model: ranAsAsked ? params.model : 'e2e-tone',
						backend: 'none',
						device: 'cpu'
					},
					stages: [{ stage: 'separate', ms: slowMs }]
				});
				return;
			}

			if (jobType === 'align') {
				await progress('aligning', 50);
				const ref = `derived/lyrics/${mediaId}.json`;
				// Word-level timings inside the fixture's 8 seconds, so the overlay has something to bounce a
				// ball along. FIELD NAMES ARE LOAD-BEARING: the TV's parser reads `start`, `end` and — inside
				// `words` — `word`. Anything else parses to an empty reel with no active word, which reads as a
				// broken overlay when the FIXTURE is what is wrong.
				const words = ['Sing', 'along', 'with', 'the', 'tone', 'now', 'here', 'we', 'go'];
				const lines = words.map((w, i) => {
					const said = longLyricLines ? [w, 'tonight', 'forever', 'under', 'bright', 'lights'] : [w];
					const step = 0.7 / said.length;
					return {
						start: i * 0.8,
						end: i * 0.8 + 0.7,
						text: said.join(' '),
						words: said.map((x, j) => ({ word: x, start: i * 0.8 + j * step, end: i * 0.8 + (j + 1) * step }))
					};
				});
				const lyrics = { source: 'fake-asr', provenance: 'transcribed', language: 'en', lines };
				if (!skipWrite) writeRef(ref, Buffer.from(JSON.stringify(lyrics, null, 1)));
				await progress('aligning', 100);
				send({
					type: 'job:complete',
					workerId,
					jobId,
					mediaUri: ref,
					// `candidates` is what makes provenance work: the core picks `chosen` from this set and the TV
					// takes its provenance label and amber unverified tint from it, so publishing only `uri`
					// leaves chosenCandidate() null and the honesty labelling untestable.
					artifacts: {
						lyrics: {
							uri: ref,
							candidates: [
								{
									// `ref`, not `uri`: a candidate carrying the wrong key name is DROPPED, which
									// leaves chosenCandidate() null and the provenance label silently absent.
									ref,
									textSource: 'asr',
									textConfidence: 'low',
									timing: 'word',
									timingConfidence: 'medium',
									language: 'en',
									createdAt: Date.now()
								}
							]
						}
					},
					facts: { asrModel: params.asrModel ?? 'base', syncMode: params.syncMode ?? 'forced' },
					stages: [{ stage: 'align', ms: slowMs }]
				});
				return;
			}

			log(`no handler for jobType=${jobType} — rejecting so the core can try elsewhere`);
			send({ type: 'job:reject', workerId, jobId, reason: `fake worker has no ${jobType}` });
		} catch (err) {
			send({ type: 'job:failed', workerId, jobId, error: String(err), retryable: true });
		} finally {
			clearInterval(keeper);
		}
	};

	let heartbeat: ReturnType<typeof setInterval> | undefined;

	ws.on('open', () => {
		log(`connected to ${world.baseURL}, media root ${mediaRoot}`);
		send({
			type: 'worker:hello',
			workerId,
			authToken: token,
			capabilities,
			concurrency,
			version: 'pw-fake',
			host: { accelerator: 'cpu', cpuCount: 2, contained: false }
		});
		heartbeat = setInterval(
			() => send({ type: 'worker:heartbeat', workerId, slotsFree: 1, runningJobIds: [] }),
			HEARTBEAT_MS
		);
	});

	ws.on('message', (raw: Buffer | string) => {
		let msg: WorkerCommand;
		try {
			msg = JSON.parse(String(raw)) as WorkerCommand;
		} catch {
			return;
		}
		if (msg.type === 'worker:welcome') {
			welcomed = true;
			log('welcomed; mediaStore =', JSON.stringify(msg.mediaStore));
			return;
		}
		if (msg.type !== 'job:assign') return;
		const { jobId, processingId, mediaId, jobType, sourceUri, params } = msg;
		// Deliberately not awaited: the handler sleeps between progress frames, and awaiting it here would
		// serialise the socket behind one job even for a worker with concurrency > 1.
		void onAssign({ jobId, processingId, mediaId, jobType, sourceUri, params });
	});

	// A 401 arrives as an HTTP response to the upgrade, never as a socket error, so it is captured here or
	// the only symptom is the welcome timeout below.
	ws.on('unexpected-response', (_req, res) => {
		upgradeFailure =
			res.statusCode === 401
				? 'core answered 401 to the role=worker upgrade: it was booted with ENCORE_WORKER_TOKEN set, so pass the ' +
					'same value as `token`.'
				: `core answered ${res.statusCode} to the role=worker upgrade.`;
		log(upgradeFailure);
	});
	ws.on('error', (err: Error) => log('ws error', err.message));
	ws.on('close', () => log('disconnected'));

	const stop = async (): Promise<void> => {
		stopped = true;
		if (heartbeat) clearInterval(heartbeat);
		if (ws.readyState === WebSocket.CLOSED) return;
		// Awaited, so the hub has deregistered this worker before the next assertion runs — otherwise a spec
		// that stops a worker to prove a job goes unservable races its own setup.
		const closed = new Promise<void>((r) => ws.once('close', () => r()));
		ws.close();
		await Promise.race([closed, sleep(2_000)]);
	};

	const deadline = Date.now() + WELCOME_TIMEOUT_MS;
	while (!welcomed && Date.now() < deadline) {
		if (upgradeFailure) {
			await stop();
			throw new Error(`fake worker ${workerId} could not connect. ${upgradeFailure}\n\n${output}`);
		}
		await sleep(25);
	}
	if (!welcomed) {
		await stop();
		throw new Error(
			`fake worker ${workerId} never received worker:welcome from ${world.baseURL} within ` +
				`${WELCOME_TIMEOUT_MS / 1000}s, so the hub never registered it and no job will ever be assigned.\n\n` +
				`worker log:\n${output}\ncore log:\n${world.core.log()}`
		);
	}

	return {
		workerId,
		get assigns() {
			return assigns;
		},
		log: () => output,
		awaitAssign: ({ jobType, mediaId, timeout = DEFAULT_ASSIGN_TIMEOUT_MS } = {}) => {
			const match = (job: AssignedJob) =>
				(jobType === undefined || job.jobType === jobType) && (mediaId === undefined || job.mediaId === mediaId);
			const already = assigns.find(match);
			if (already) return Promise.resolve(already);
			const wanted = [jobType ?? 'any job type', mediaId ?? 'any media'].join(' / ');
			return new Promise<AssignedJob>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(
						new Error(
							`fake worker ${workerId} saw no job:assign for ${wanted} within ${timeout}ms. Saw: ` +
								`${assigns.map((a) => `${a.jobType}(${a.mediaId})`).join(', ') || 'nothing'}.\n\n${output}`
						)
					);
				}, timeout);
				waiters.push({
					match,
					resolve: (job) => {
						clearTimeout(timer);
						resolve(job);
					}
				});
			});
		},
		stop
	};
}

/**
 * A worker that ADVERTISES and never claims: it records every `job:assign` and lets `awaitAssign` read the
 * frame's `params`, which is how "the model and sync mode chosen on the settings page reach the wire" is
 * proved. Params are computed at ASSIGN time, so this also shows a settings change taking effect on work that
 * was already queued.
 *
 * The assigned job is NOT completed — its ack lease expires after ~10s and it requeues with attempts
 * unchanged, so a spec that wants the song to finish afterwards starts a claiming worker too.
 */
export async function startObservingWorker(
	world: WorkerWorld,
	options: Omit<FakeWorkerOptions, 'claim'> = {}
): Promise<FakeWorker> {
	return startFakeWorker(world, { capabilities: ['align'], ...options, claim: 'none' });
}
