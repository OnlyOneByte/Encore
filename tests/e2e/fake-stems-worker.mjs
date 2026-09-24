/*
 * A worker that dials home, claims real jobs and publishes REAL AUDIO, running the whole core-side process
 * path (dispatch → accept → progress → publish → markMediaReady → queue:sync → TV loads → sound comes out)
 * and skipping only what this box cannot do: no torch/demucs/whisperx, and no ffmpeg that can encode, so it
 * writes hand-emitted PCM (./wav.mjs) instead of separated stems. It proves nothing about separation
 * quality, alignment accuracy, or whether yt-dlp can still reach YouTube.
 *
 *   EPORT=5200 MEDIA_DIR=/path/to/media bun tests/e2e/fake-stems-worker.mjs
 *
 * Fault-injection env vars: docs/E2E.md#fault-injection.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tone, silence } from './wav.mjs';

const port = process.env.EPORT ?? '3000';
const mediaRoot = resolve(process.env.MEDIA_DIR ?? './media');
const workerId = process.env.FAKE_WORKER_ID ?? 'fake-stems-1';
const slowMs = Number(process.env.FAKE_SLOW_MS ?? 120);
const failType = process.env.FAKE_FAIL ?? '';
const log = (/** @type {unknown[]} */ ...a) => console.log('[fake-worker]', ...a);

// Storage classes may each be pointed at their own volume, so mirror paths.ts rather than assuming
// everything sits under MEDIA_DIR — otherwise the worker writes where core will not look.
/** @param {string} cls @returns {string} */
const classDir = (cls) => {
	/** @type {Record<string, string>} */
	const envByClass = { audio: 'ENCORE_AUDIO_DIR', derived: 'ENCORE_DERIVED_DIR', meta: 'ENCORE_META_DIR' };
	const env = envByClass[cls];
	const v = env && process.env[env]?.trim();
	return v ? resolve(v) : join(mediaRoot, cls);
};
/** Write bytes for a relative ref like "derived/stems/<id>-instrumental.wav". */
/** @param {string} ref @param {Uint8Array} bytes @returns {string} */
function writeRef(ref, bytes) {
	const [head, ...rest] = ref.split('/');
	const abs = join(classDir(head), rest.join('/'));
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, bytes);
	log(`wrote ${ref} (${(bytes.length / 1024).toFixed(0)} KB)`);
	return abs;
}

const ws = new WebSocket(
	`ws://127.0.0.1:${port}/ws?role=worker${process.env.ENCORE_WORKER_TOKEN ? `&token=${process.env.ENCORE_WORKER_TOKEN}` : ''}`
);
const send = (/** @type {unknown} */ m) => ws.send(JSON.stringify(m));
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

ws.onopen = () => {
	log(`connected to :${port}, media root ${mediaRoot}`);
	send({
		type: 'worker:hello',
		workerId,
		authToken: process.env.ENCORE_WORKER_TOKEN,
		capabilities: (process.env.FAKE_CAPS ?? 'fetch,stems,align').split(','),
		concurrency: Number(process.env.FAKE_CONCURRENCY ?? 1),
		version: 'e2e-fake',
		host: { accelerator: 'cpu', cpuCount: 2, contained: false }
	});
	setInterval(() => send({ type: 'worker:heartbeat', workerId, slotsFree: 1, runningJobIds: [] }), 5000);
};

ws.onmessage = async (/** @type {MessageEvent} */ ev) => {
	const msg = JSON.parse(String(ev.data));
	if (msg.type === 'worker:welcome') return log('welcomed; mediaStore =', JSON.stringify(msg.mediaStore));
	if (msg.type !== 'job:assign') return;

	const { jobId, mediaId, jobType, sourceUri, params } = msg;
	log(`assigned ${jobType} job=${jobId} media=${mediaId} src=${sourceUri} params=${JSON.stringify(params)}`);
	send({ type: 'job:accept', workerId, jobId });

	if (failType && failType === jobType) {
		await sleep(slowMs);
		log(`failing ${jobType} on purpose`);
		return send({ type: 'job:failed', workerId, jobId, error: `injected failure for ${jobType}`, retryable: false });
	}

	// Progress frames drive the phone's processing bar and refresh the lease, so send real ones.
	const progress = async (/** @type {string} */ stage, /** @type {number} */ pct) => {
		send({ type: 'job:progress', workerId, jobId, stage, pct });
		await sleep(slowMs);
	};

	try {
		if (jobType === 'fetch') {
			await progress('downloading', 40);
			const ref = `audio/${mediaId}.wav`;
			if (!process.env.FAKE_SKIP_WRITE) writeRef(ref, tone({ seconds: 8, hz: [196, 246.94, 293.66] }));
			await progress('downloading', 100);
			return send({
				type: 'job:complete',
				workerId,
				jobId,
				mediaUri: ref,
				facts: { engine: 'fake-fetch' },
				stages: [{ stage: 'download', ms: slowMs }]
			});
		}

		if (jobType === 'stems' || jobType === 'stems-upgrade') {
			await progress('separating', 25);
			// .wav rather than the flac/m4a the real policy names: the key helpers take an explicit ext and
			// the media route maps wav → audio/wav, so this is a legal ref a browser can play.
			const insRef = `derived/stems/${mediaId}-instrumental.wav`;
			const vocRef = `derived/stems/${mediaId}-vocals.wav`;
			const mixRef = `derived/stems/${mediaId}-guide.wav`;
			if (!process.env.FAKE_SKIP_WRITE) {
				writeRef(
					insRef,
					process.env.FAKE_SILENT_INSTRUMENTAL ? silence() : tone({ seconds: 8, hz: [220, 277.18, 329.63] })
				);
				// FAKE_NO_VOCALS writes no vocals file, because it reports no vocals ref either.
				if (!process.env.FAKE_NO_VOCALS) {
					writeRef(vocRef, process.env.FAKE_SILENT_VOCALS ? silence() : tone({ seconds: 8, hz: [440], amp: 0.2 }));
				}
				// A real file so the media route can serve it, but the CHANNEL COUNT is a lie — this writes the
				// same 1-channel tone as the stems. Sufficient because every gate that reads it tests only the
				// ref's PRESENCE; a probe needing real 4-channel audio needs the real worker.
				if (process.env.FAKE_GUIDE_MIX) {
					writeRef(mixRef, tone({ seconds: 8, hz: [220, 440], amp: 0.3 }));
				}
			}
			await progress('separating', 90);
			/** @type {{ stems: { instrumental: string, vocals?: string, guideMix?: string }, songProfile?: Record<string, unknown> }} */
			const artifacts = process.env.FAKE_NO_VOCALS
				? { stems: { instrumental: insRef } }
				: { stems: { instrumental: insRef, vocals: vocRef } };
			// OPT-IN: a guide mix is what makes a song GUIDABLE, so switching it on by default would silently
			// change which arm every existing probe exercises.
			if (process.env.FAKE_GUIDE_MIX && !process.env.FAKE_NO_VOCALS) {
				artifacts.stems.guideMix = mixRef;
			}
			// songProfile is a SIBLING of stems, never a member, or every process stalls at "Separating
			// vocals" forever. FIELD NAMES matter as much as placement: `normalizeSongProfile` silently
			// discards anything else down to keyTonic:null, which leaves the TV's key line unrendered and
			// reads as a key-shift defect. keyTonic is a PitchClass (0=C … 9=A); the range is MIDI note
			// numbers, not hertz.
			if (!process.env.FAKE_NO_PROFILE) {
				artifacts.songProfile = {
					keyTonic: 9, // A
					keyMode: 'minor', // the fixture chord is A/C#/E-ish — call it A minor
					keyConfidence: 0.82,
					lowMidi: 50,
					highMidi: 69, // the vocals fixture is a 440 Hz tone = A4 = MIDI 69
					p05Midi: 55,
					p95Midi: 67,
					histogram: Array.from({ length: 20 }, (_, i) => Math.round(Math.sin((i / 19) * Math.PI) * 40) / 10)
				};
			}
			return send({
				type: 'job:complete',
				workerId,
				jobId,
				mediaUri: insRef,
				artifacts,
				facts: { engine: 'fake-separator', model: 'e2e-tone', backend: 'none', device: 'cpu' },
				stages: [{ stage: 'separate', ms: slowMs }]
			});
		}

		if (jobType === 'align') {
			await progress('aligning', 50);
			const ref = `derived/lyrics/${mediaId}.json`;
			// Word-level timings inside the fixture's 8 seconds, so the overlay has something to bounce a
			// ball along. FIELD NAMES ARE LOAD-BEARING: the TV's parser reads `start`, `end` and — inside
			// `words` — `word`. Anything else parses to an empty reel with no active word, which reads as a
			// broken overlay when the FIXTURE is what is wrong.
			const words = ['Sing', 'along', 'with', 'the', 'tone', 'now', 'here', 'we', 'go'];
			const lines = words.map((w, i) => ({
				start: i * 0.8,
				end: i * 0.8 + 0.7,
				text: w,
				words: [{ word: w, start: i * 0.8, end: i * 0.8 + 0.7 }]
			}));
			const lyrics = { source: 'fake-asr', provenance: 'transcribed', language: 'en', lines };
			if (!process.env.FAKE_SKIP_WRITE) writeRef(ref, Buffer.from(JSON.stringify(lyrics, null, 1)));
			await progress('aligning', 100);
			return send({
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
				facts: { asrModel: params?.asrModel ?? 'base', syncMode: params?.syncMode ?? 'forced' },
				stages: [{ stage: 'align', ms: slowMs }]
			});
		}

		log(`no handler for jobType=${jobType} — rejecting so the core can try elsewhere`);
		send({ type: 'job:reject', workerId, jobId, reason: `fake worker has no ${jobType}` });
	} catch (err) {
		send({ type: 'job:failed', workerId, jobId, error: String(err), retryable: true });
	}
};

ws.onerror = (/** @type {Event} */ e) => log('ws error', e instanceof ErrorEvent ? e.message : e.type);
ws.onclose = () => log('disconnected');
