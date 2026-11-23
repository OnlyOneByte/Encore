// THE TV'S LOUDNESS PULLDOWN, END TO END, ON A LEAN SYNC. `queue:sync` carries only the QUEUED songs' media
// plus `loudness: number[]`, the measured LUFS of every song the server holds (hub.ts#loudnessLevelsOf). The TV's
// library median — and so the master level `loudnessNormalizationGain` resolves — can only come from that array
// now, because the TV's catalog no longer holds the unqueued songs.
//
// So the subject is staged to make `e.loudness` the ONLY possible source: ten measured songs on the server (nine at
// -14 LUFS, one outlier at -2), and the outlier the ONLY song queued. If the TV derived the median from what the
// sync's `media` carries, it would see one measured song, fall below LOUDNESS_MEASURED_FLOOR (8) and play at unity.
//
// Expected: median -14, clamp N = 6 dB, so the outlier is pulled to -8: 10^((-14 + 6 - (-2)) / 20) = 10^(-0.3).
//
// WHERE THE LEVEL IS READ: TvPlayer applies `masterLevel` at two sites — the element's `.volume` on the native path
// and `masterGraph.setGain` once a transpose routes through WebAudio. This song has no guide mix and key 0, so no
// graph is built and `.volume` is the level the room hears.
//
// It reads element state, never audio: docs/E2E.md#proving-audio.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import { processTrack, queueReadyTrack, readMaster, tapStage, type ReadyMedia } from './audio-probe-support';
import type { DemoTrack } from '../../world/seed';

const QUIET_LUFS = -14;
const OUTLIER_LUFS = -2;
const CLAMP_N_DB = 6;
const EXPECTED_GAIN = 10 ** ((QUIET_LUFS + CLAMP_N_DB - OUTLIER_LUFS) / 20); // ≈ 0.501

/** Single-token, collision-free titles: the local resolver builds an FTS5 prefix MATCH from the query, so each
 *  query must find exactly its own file (docs/E2E.md#the-demo-library). */
const QUIET = ['calma', 'calmb', 'calmc', 'calmd', 'calme', 'calmf', 'calmg', 'calmh', 'calmi'].map((t) => ({
	title: t,
	q: t
}));
const OUTLIER = { title: 'outlierzq', q: 'outlierzq' };

const LIBRARY: DemoTrack[] = [...QUIET, OUTLIER].map((t, i) => ({
	file: `${t.title}.wav`,
	seconds: 8,
	hz: [220 + i * 10]
}));

test.use({ demoLibrary: [LIBRARY, { scope: 'test' }] });

interface SyncFrame {
	type: 'queue:sync';
	entries: { mediaId: string }[];
	media?: { id: string }[];
	loudness?: number[];
}

test('the TV pulls a loud outlier down against the library median carried on a lean sync', async ({ world }) => {
	// Ten processes plus a core boot: generous, but every wait below has its own deadline and message.
	test.setTimeout(180_000);
	await world.awaitDemoTrack('outlierzq');
	const phone = await world.openPhone('Level');
	await openBrowseFromHome(phone);

	await world.becomeHost(phone);
	const res = await phone.request.put(`${world.baseURL}/api/settings/room`, {
		data: { loudnessNormalization: true }
	});
	expect(res.ok(), `PUT /api/settings/room answered ${res.status()}`).toBe(true);

	// Two workers, one at a time, because the fake worker reports ONE level for every stems job: the quiet nine
	// through the first, the outlier through the second. Processed, NOT queued — the subject is a library the
	// queue does not carry.
	const quietWorker = await startFakeWorker(world, { loudnessLufs: QUIET_LUFS });
	try {
		for (const track of QUIET) await processTrack(phone, world.baseURL, track);
	} finally {
		await quietWorker.stop();
	}
	const loudWorker = await startFakeWorker(world, { loudnessLufs: OUTLIER_LUFS, seconds: 30 });
	let outlier: ReadyMedia;
	try {
		outlier = await processTrack(phone, world.baseURL, OUTLIER);
	} finally {
		await loudWorker.stop();
	}

	// Every queue:sync the TV receives, from the document it actually runs — registered before the reload so the
	// hello's sync is in it.
	const tv = await world.openTv();
	const syncs: SyncFrame[] = [];
	tv.on('websocket', (ws) =>
		ws.on('framereceived', ({ payload }) => {
			try {
				const e = JSON.parse(String(payload)) as { type?: string };
				if (e.type === 'queue:sync') syncs.push(e as SyncFrame);
			} catch {
				/* not a JSON frame */
			}
		})
	);
	await tv.reload();
	await tv.locator(SEL.tvRoot).first().waitFor({ state: 'attached', timeout: 30_000 });
	await tapStage(tv);

	await queueReadyTrack(phone, OUTLIER);

	// THE CLAIM. Polled, because the level is applied by an effect after the slot mounts; the song is 30 s, so the
	// element is on stage for the whole window. The poll yields the VOLUME (null until the outlier's element is
	// up), so a failure prints the level the room actually got.
	await expect
		.poll(
			async () => {
				const m = await readMaster(tv);
				return m && m.src.includes(outlier.id) ? m.volume : null;
			},
			{
				timeout: 20_000,
				message:
					`the TV must play "${OUTLIER.title}" at ${EXPECTED_GAIN.toFixed(4)} (median ${QUIET_LUFS}, clamp ` +
					`${CLAMP_N_DB} dB). A volume of 1 means the TV had no library median — the sync's \`loudness\` never ` +
					`reached \`libraryLoudnessLevels\`.`
			}
		)
		.toBeCloseTo(EXPECTED_GAIN, 3);

	// LEAN: the sync that carried the queued outlier held ITS media only, and the whole library's levels beside it.
	const queued = syncs.filter((s) => s.entries.some((e) => e.mediaId === outlier.id));
	expect(queued.length, `the TV received no queue:sync naming the outlier (saw ${syncs.length} syncs)`).toBeGreaterThan(
		0
	);
	const sync = queued[queued.length - 1]!;
	const queuedIds = new Set(sync.entries.map((e) => e.mediaId));
	expect(
		sync.media?.length,
		`sync.media must be the queued songs only: ${JSON.stringify(sync.media?.map((m) => m.id))}`
	).toBe(queuedIds.size);
	expect(
		[...(sync.loudness ?? [])].sort((a, b) => a - b),
		'sync.loudness must carry every measured song the server holds'
	).toEqual([...Array(QUIET.length).fill(QUIET_LUFS), OUTLIER_LUFS].sort((a, b) => a - b));
});
