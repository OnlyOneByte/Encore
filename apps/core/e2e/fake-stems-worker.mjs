/*
 * A worker that dials home, claims real jobs, and publishes REAL AUDIO.
 *
 * The point is not to fake the pipeline — it is to run the whole core-side cook path for real
 * (dispatch → accept → progress → publish → markMediaReady → queue:sync → TV loads → sound comes out)
 * while skipping only the part this box cannot do: torch, demucs and whisperx are not installed, and
 * neither ffmpeg here can encode. So this worker does exactly what the Python one does over the wire,
 * and writes hand-emitted PCM (see ./wav.mjs) instead of separated stems.
 *
 * That distinction matters for what a pass MEANS. A green run here proves the core's contract, the
 * storage layout, the readiness gates and the browser's decode path. It does NOT prove separation
 * quality, alignment accuracy, or that yt-dlp can still reach YouTube.
 *
 *   EPORT=5200 MEDIA_DIR=/path/to/media bun apps/core/e2e/fake-stems-worker.mjs
 *
 * Fault injection, because the interesting defects are all in the unhappy paths:
 *   FAKE_SILENT_INSTRUMENTAL=1  publish a floor-level instrumental (the guard must refuse it)
 *   FAKE_SILENT_VOCALS=1        publish a floor-level vocals stem (must NOT fail the cook)
 *   FAKE_SKIP_WRITE=1           report a ref for a file never written (the unservable path)
 *   FAKE_NO_PROFILE=1           complete with no songProfile (the gate must not deadlock)
 *   FAKE_FAIL=stems             fail that job type instead of completing it
 *   FAKE_SLOW_MS=1500           dwell between progress frames, to watch the cooking UI
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tone, silence } from './wav.mjs';

const port = process.env.EPORT ?? '3000';
const mediaRoot = resolve(process.env.MEDIA_DIR ?? './media');
const workerId = process.env.FAKE_WORKER_ID ?? 'fake-stems-1';
const slowMs = Number(process.env.FAKE_SLOW_MS ?? 120);
const failType = process.env.FAKE_FAIL ?? '';
const log = (...a) => console.log('[fake-worker]', ...a);

// Storage classes may each be pointed at their own volume; mirror paths.ts rather than assuming
// everything sits under MEDIA_DIR, or the worker writes where core will not look.
const classDir = (cls) => {
	const env = { audio: 'ENCORE_AUDIO_DIR', derived: 'ENCORE_DERIVED_DIR', meta: 'ENCORE_META_DIR' }[cls];
	const v = env && process.env[env]?.trim();
	return v ? resolve(v) : join(mediaRoot, cls);
};
/** Write bytes for a relative ref like "derived/stems/<id>-instrumental.wav". */
function writeRef(ref, bytes) {
	const [head, ...rest] = ref.split('/');
	const abs = join(classDir(head), rest.join('/'));
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, bytes);
	log(`wrote ${ref} (${(bytes.length / 1024).toFixed(0)} KB)`);
	return abs;
}

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=worker${process.env.ENCORE_WORKER_TOKEN ? `&token=${process.env.ENCORE_WORKER_TOKEN}` : ''}`);
const send = (m) => ws.send(JSON.stringify(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

ws.onmessage = async (ev) => {
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

	// Progress frames drive the phone's cooking bar and refresh the lease, so send real ones.
	const progress = async (stage, pct) => {
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
			// .wav rather than the flac/m4a the real policy names: the key helpers take an explicit ext
			// and the media route maps wav → audio/wav, so this is a legal ref that a browser can play.
			const insRef = `derived/stems/${mediaId}-instrumental.wav`;
			const vocRef = `derived/stems/${mediaId}-vocals.wav`;
			if (!process.env.FAKE_SKIP_WRITE) {
				writeRef(insRef, process.env.FAKE_SILENT_INSTRUMENTAL ? silence() : tone({ seconds: 8, hz: [220, 277.18, 329.63] }));
				writeRef(vocRef, process.env.FAKE_SILENT_VOCALS ? silence() : tone({ seconds: 8, hz: [440], amp: 0.2 }));
			}
			await progress('separating', 90);
			const artifacts = { stems: { instrumental: insRef, vocals: vocRef } };
			// songProfile is a SIBLING of stems, never a member — the shape drift that once stalled
			// every cook at "Separating vocals" forever. Publishing it correctly here is the point.
			//
			// The FIELD NAMES matter as much as the placement. An earlier version of this file invented
			// `{key, lowHz, highHz, medianHz}`, which `normalizeSongProfile` silently discarded down to
			// keyTonic:null — so `keySounding` was null, the TV's key line never rendered, and a probe
			// reasonably read that as a defect in the key-shift feature. Match the real shape:
			// keyTonic is a PitchClass (0=C … 9=A) and the range is in MIDI note numbers, not hertz.
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
			// Word-level timings inside the fixture's 8 seconds, so the overlay has something real to
			// bounce a ball along and a reviewer can see whether the highlight tracks the clock.
			//
			// FIELD NAMES ARE LOAD-BEARING. The TV's parser (src/lib/tv/lyrics.ts) reads `start`, `end`
			// and — inside `words` — `word`. An earlier version of this file wrote `startSec`, `endSec`
			// and `text`, which parsed to an empty reel: no active word ever appeared, and a probe read
			// that as the overlay being broken when the app was fine and the FIXTURE was wrong. Keep
			// these names identical to what apps/worker publishes.
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
				// `candidates` is what makes provenance work. The core picks `chosen` from this set, and
				// the TV decides whether to show the "Auto-Transcribed" label and the amber unverified
				// tint from the chosen candidate — so publishing only `uri` leaves chosenCandidate()
				// null and the honesty labelling untestable. asr + low confidence is what an
				// auto-transcription actually is, and it is exactly the case the label exists for.
				artifacts: {
					lyrics: {
						uri: ref,
						candidates: [
							{
								// `ref`, not `uri` — LyricsCandidate names the MediaStore key `ref`, and a
								// candidate carrying the wrong key name is dropped, which leaves
								// chosenCandidate() null and the provenance label silently absent.
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

ws.onerror = (e) => log('ws error', e?.message ?? e);
ws.onclose = () => log('disconnected');
