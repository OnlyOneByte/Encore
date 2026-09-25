import {
	DEFAULT_GLOBAL_SETTINGS,
	isQualityUpgrade,
	qualityRank,
	type GlobalSettings,
	type Job,
	type JobType,
	type Media
} from '$lib/contract';
import {
	assignParams,
	followUps,
	hasCapableWorker,
	planAssignments,
	requiredCapability,
	separatorFor,
	type CapabilityFor
} from '$lib/server/jobs/dispatch';
import { markMediaReady } from '$lib/server/jobs/process';
import type { WorkerSession } from '$lib/server/jobs/registry';
import { expect, test } from 'bun:test';

// Pure dispatch policy — need-order (priority ASC, createdAt tiebreak), least-loaded worker,
// capability match, capacity respected within a single planning pass.

const T0 = 1_700_000_000_000;

function job(id: string, over: Partial<Job> = {}): Job {
	return {
		id,
		mediaId: 'm-' + id,
		processingId: 'process-' + id,
		singerId: null,
		jobType: 'stems',
		status: 'queued',
		priority: 0,
		attempts: 0,
		maxAttempts: 3,
		workerId: null,
		stage: null,
		progressPct: 0,
		etaSec: null,
		error: null,
		leaseExpiresAt: null,
		createdAt: T0,
		updatedAt: T0,
		...over
	};
}

function worker(id: string, slotsFree: number, capabilities: JobType[] = ['stems']): WorkerSession {
	return { workerId: id, capabilities, concurrency: slotsFree, version: '1', slotsFree, lastSeen: T0 };
}

test('a single queued job goes to the only eligible worker', () => {
	expect(planAssignments([job('a')], [worker('w1', 1)])).toEqual([{ jobId: 'a', workerId: 'w1' }]);
});

test('no eligible worker (capability mismatch) → job left queued', () => {
	const j = job('a', { jobType: 'align' });
	expect(planAssignments([j], [worker('w1', 1, ['stems'])])).toEqual([]);
	expect(hasCapableWorker(j, [worker('w1', 1, ['stems'])])).toBe(false);
	expect(hasCapableWorker(j, [worker('w2', 1, ['align'])])).toBe(true);
});

test('need-order: lower priority (=sooner rotationSeq) dispatches first', () => {
	const a = job('far', { priority: 9 });
	const b = job('soon', { priority: 1 });
	expect(planAssignments([a, b], [worker('w1', 1)])).toEqual([{ jobId: 'soon', workerId: 'w1' }]);
});

test('priority tie broken by createdAt (older first)', () => {
	const older = job('older', { priority: 5, createdAt: T0 });
	const newer = job('newer', { priority: 5, createdAt: T0 + 100 });
	expect(planAssignments([newer, older], [worker('w1', 1)])).toEqual([{ jobId: 'older', workerId: 'w1' }]);
});

test('least-loaded worker chosen (most slotsFree)', () => {
	const a = planAssignments([job('a')], [worker('busy', 1), worker('idle', 4)]);
	expect(a).toEqual([{ jobId: 'a', workerId: 'idle' }]);
});

test('capacity respected within one pass: 3 jobs, worker concurrency 2 → 1 left queued', () => {
	const jobs = [job('a', { priority: 1 }), job('b', { priority: 2 }), job('c', { priority: 3 })];
	const out = planAssignments(jobs, [worker('w1', 2)]);
	expect(out).toHaveLength(2);
	expect(out.map((x) => x.jobId)).toEqual(['a', 'b']); // c starves until a slot frees
});

test('jobs spread across workers, balancing load', () => {
	const jobs = [job('a', { priority: 1 }), job('b', { priority: 2 })];
	const out = planAssignments(jobs, [worker('w1', 1), worker('w2', 1)]);
	expect(new Set(out.map((x) => x.workerId))).toEqual(new Set(['w1', 'w2']));
});

// Align enqueueing, the fields `job:assign` must carry for it, and the confidence rule that decides
// whether a lyrics lookup is attempted at all.

const media = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'Britney Spears - Baby One More Time (Lyrics)', // the RAW title, as search stores it
	artist: '7clouds', // the UPLOADER, not the artist
	durationSec: 211,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: 'derived/stems/i-instrumental.flac',
	...over
});

test('the process is fetch -> stems -> align, and ends there', () => {
	// align is the LAST step of a process: a song is not finished until its words are timed.
	expect(followUps('fetch')).toEqual(['stems']);
	expect(followUps('stems')).toEqual(['align']);
});

test('align does not chain further — no infinite pipeline', () => {
	expect(followUps('align')).toEqual([]);
});

// The artist credit tells two RECORDINGS of one song apart. A lyrics provider holds a record per
// version and every one matches the primary artist, so "Lady Gaga / Telephone" alone cannot pick the
// release with Beyoncé's verse over the one without — the worker gets whichever the provider returns.

test('THE GAP: the full billing rides on an align job, not just the primary artist', () => {
	const p = assignParams(
		'align',
		media({ artistCanonical: 'Lady Gaga', titleCanonical: 'Telephone', artistCredit: 'Lady Gaga feat. Beyoncé' })
	);
	expect(p.artist).toBe('Lady Gaga'); // the LOOKUP key stays the primary
	expect(p.artistCredit).toBe('Lady Gaga feat. Beyoncé'); // the RANKING signal rides alongside
});

test('the credit is omitted when it would only repeat the primary artist', () => {
	// A solo song's billing IS its primary artist, so sending it scores every candidate identically:
	// noise on the worker's ranking axis, not evidence.
	const p = assignParams(
		'align',
		media({ artistCanonical: 'a-ha', titleCanonical: 'Take On Me', artistCredit: 'a-ha' })
	);
	expect(p.artistCredit).toBeUndefined();
});

test('a song with no parsed credit sends none', () => {
	// Absent, not empty: a consumer must tell "no credit" from "credit is blank".
	expect(
		assignParams('align', media({ artistCanonical: 'a-ha', titleCanonical: 'Take On Me' })).artistCredit
	).toBeUndefined();
});

test('the credit is NOT a lookup key — it never replaces artist or track', () => {
	// The credit only RANKS what a search returned: querying the full billing misses every record filed
	// under the primary artist alone.
	const p = assignParams(
		'align',
		media({ artistCanonical: 'Lady Gaga', titleCanonical: 'Telephone', artistCredit: 'Lady Gaga feat. Beyoncé' })
	);
	expect(p.artist).not.toContain('Beyoncé');
	expect(p.track).toBe('Telephone');
});

test('fetch carries the credit too, since it shares the lookup keys', () => {
	const p = assignParams(
		'fetch',
		media({ artistCanonical: 'Lady Gaga', titleCanonical: 'Telephone', artistCredit: 'Lady Gaga feat. Beyoncé' }),
		DEFAULT_GLOBAL_SETTINGS
	);
	expect(p.artistCredit).toBe('Lady Gaga feat. Beyoncé');
});

test('stems still gets its separation model', () => {
	expect(assignParams('stems', media()).model).toBe('htdemucs');
});

test('stems carries the room engine+model; upgrade carries the upgrade engine+model', () => {
	const settings = {
		...DEFAULT_GLOBAL_SETTINGS,
		defaultEngine: 'demucs' as const,
		defaultModel: 'htdemucs_ft',
		enqueueUpgrade: true,
		upgradeEngine: 'roformer' as const,
		upgradeModel: 'bs-roformer-1297'
	};
	const stems = assignParams('stems', media(), settings);
	expect(stems.engine).toBe('demucs');
	expect(stems.model).toBe('htdemucs_ft');
	const upgrade = assignParams('stems-upgrade', media(), settings);
	expect(upgrade.engine).toBe('roformer');
	expect(upgrade.model).toBe('bs-roformer-1297');
});

test('with no settings, stems falls back to the shared default pairing', () => {
	const p = assignParams('stems', media());
	expect(p.engine).toBe('demucs');
	expect(p.model).toBe('htdemucs');
});

test('THE BUG: align now carries canonical artist + track, not the uploader and raw title', () => {
	const p = assignParams('align', media({ artistCanonical: 'Britney Spears', titleCanonical: 'Baby One More Time' }));
	expect(p.artist).toBe('Britney Spears');
	expect(p.track).toBe('Baby One More Time');
	expect(p.artist).not.toBe('7clouds');
	expect(p.track).not.toContain('(Lyrics)');
});

test('durationSec rides along to narrow the match', () => {
	expect(assignParams('align', media({ artistCanonical: 'a', titleCanonical: 'b' })).durationSec).toBe(211);
});

test('a low-confidence parse OMITS the field rather than sending a guess', () => {
	// Omitting artistCanonical/titleCanonical is how the worker learns no authoritative lookup is
	// possible and goes straight to transcription.
	const p = assignParams('align', media());
	expect(p.artist).toBeUndefined();
	expect(p.track).toBeUndefined();
	expect(p.durationSec).toBe(211); // duration is always safe to send
});

test('a confident artist with an unconfident title still omits only the title', () => {
	const p = assignParams('align', media({ artistCanonical: 'Britney Spears' }));
	expect(p.artist).toBe('Britney Spears');
	expect(p.track).toBeUndefined();
});

test("the operator's chosen reader and timing mode ride on every align job", () => {
	// The whole delivery mechanism for the setting: without these fields on the job, nothing an operator
	// changes can reach the words on the TV.
	const p = assignParams('align', media(), {
		...DEFAULT_GLOBAL_SETTINGS,
		asrModel: 'medium',
		syncMode: 'lines'
	});
	expect(p.asrModel).toBe('medium');
	expect(p.syncMode).toBe('lines');
});

test('with no settings, align falls back to what the worker used when these were hardcoded', () => {
	// A caller that passes no settings must not silently change the model.
	const p = assignParams('align', media());
	expect(p.asrModel).toBe('base');
	expect(p.syncMode).toBe('forced');
});

test('the lyrics engines are for align only — a stems job carries a separator instead', () => {
	// A separation job has no opinion about words, so the two axes must not bleed into each other.
	const s = { ...DEFAULT_GLOBAL_SETTINGS, asrModel: 'small' as const, syncMode: 'lines' as const };
	expect(assignParams('stems', media(), s).asrModel).toBeUndefined();
	expect(assignParams('stems', media(), s).syncMode).toBeUndefined();
	expect(assignParams('fetch', media(), s).asrModel).toBeUndefined();
});

test('unknown media and a zero duration do not produce junk params', () => {
	// The fetcher and the lyrics engines are DECLARATIONS the worker needs, not junk: an align job says
	// which model reads the words and how they get timestamps, as a stems job says which separator to
	// run. Only the LOOKUP keys stay absent when unconfident.
	expect(assignParams('align', undefined)).toEqual({ fetcher: 'ytdlp', asrModel: 'base', syncMode: 'forced' });
	expect(assignParams('align', media({ durationSec: 0 })).durationSec).toBeUndefined();
});

function job_CapabilityRouting(id: string, jobType: Job['jobType']): Job {
	return {
		id,
		mediaId: 'm-' + id,
		jobType,
		status: 'queued',
		priority: 1,
		attempts: 0,
		maxAttempts: 3,
		workerId: null,
		stage: null,
		progressPct: 0,
		etaSec: null,
		error: null,
		leaseExpiresAt: null,
		createdAt: 1,
		updatedAt: 1
	} as Job;
}

function worker_CapabilityRouting(id: string, capabilities: string[], slotsFree = 1): WorkerSession {
	return { workerId: id, capabilities, concurrency: slotsFree, version: '1', slotsFree, lastSeen: 0 };
}

const settings = (o: Partial<GlobalSettings>): GlobalSettings => ({
	...DEFAULT_GLOBAL_SETTINGS,
	defaultModel: 'htdemucs',
	...o
});

test('requiredCapability is engine-derived for stems, plain type otherwise', () => {
	expect(requiredCapability('stems', settings({ defaultEngine: 'demucs' }))).toBe('stems');
	expect(requiredCapability('stems', settings({ defaultEngine: 'roformer' }))).toBe('stems:roformer');
	expect(requiredCapability('stems-upgrade', settings({ upgradeEngine: 'ensemble' }))).toBe('stems:ensemble');
	expect(requiredCapability('align', settings({}))).toBe('align');
	// No settings means the demucs default and a plain 'stems' capability, which single-cap workers serve.
	expect(requiredCapability('stems')).toBe('stems');
});

test('a roformer process is NOT dispatched to a demucs-only worker_CapabilityRouting', () => {
	const cap: CapabilityFor = (j) => requiredCapability(j.jobType, settings({ defaultEngine: 'roformer' }));
	const demucsOnly = [worker_CapabilityRouting('w1', ['stems'])];
	const stems = [job_CapabilityRouting('a', 'stems')];
	expect(planAssignments(stems, demucsOnly, cap)).toEqual([]); // left queued, not mis-assigned
	expect(hasCapableWorker(stems[0], demucsOnly, cap)).toBe(false);

	const roformerWorker = [worker_CapabilityRouting('w2', ['stems', 'stems:roformer'])];
	expect(planAssignments(stems, roformerWorker, cap)).toEqual([{ jobId: 'a', workerId: 'w2' }]);
	expect(hasCapableWorker(stems[0], roformerWorker, cap)).toBe(true);
});

test('default capabilityFor (no resolver) preserves plain job_CapabilityRouting-type routing', () => {
	const demucsOnly = [worker_CapabilityRouting('w1', ['stems'])];
	expect(planAssignments([job_CapabilityRouting('a', 'stems')], demucsOnly)).toEqual([{ jobId: 'a', workerId: 'w1' }]);
});

// The acquisition CHAIN: get the bytes, then separate them. Enqueueing `stems` directly dispatches a separation before
// its input exists; a `fetch` that chains to nothing leaves every song with audio on disk and no instrumental.

const settings_FetchChain = (o: Partial<GlobalSettings> = {}): GlobalSettings => ({ ...DEFAULT_GLOBAL_SETTINGS, ...o });
const media_FetchChain = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'Take On Me',
	durationSec: 225,
	stemStatus: 'none',
	...over
});

test('fetch chains to stems — acquisition is never a dead end', () => {
	expect(followUps('fetch', settings_FetchChain())).toEqual(['stems']);
});

test('fetch does NOT chain align/score directly — those need the vocals stem', () => {
	// align reads the isolated vocals, so chaining it off fetch races the separation that produces it.
	const next = followUps('fetch', settings_FetchChain());
	expect(next).not.toContain('align');
});

test('fetch routes on the DOWNLOADER capability, not on stems', () => {
	// Neither capability implies the other, so the two steps can run on different machines.
	expect(requiredCapability('fetch', settings_FetchChain())).toBe('fetch:ytdlp');
	expect(requiredCapability('stems', settings_FetchChain())).toBe('stems');
	expect(requiredCapability('fetch', settings_FetchChain())).not.toBe(
		requiredCapability('stems', settings_FetchChain())
	);
});

test('fetch capability falls back sanely with no settings_FetchChain at all (older callers, unit tests)', () => {
	expect(requiredCapability('fetch')).toBe('fetch:ytdlp');
});

test('every job that touches source audio declares HOW to obtain it', () => {
	for (const jobType of ['fetch', 'stems', 'stems-upgrade', 'align'] as const) {
		expect(assignParams(jobType, media_FetchChain(), settings_FetchChain()).fetcher).toBe('ytdlp');
	}
});

test('a LOCAL media_FetchChain declares `local`, so the worker reads a path instead of downloading', () => {
	const local = media_FetchChain({ source: 'local', sourceRef: 'library/x.mp4' });
	expect(assignParams('stems', local, settings_FetchChain()).fetcher).toBe('local');
	// `local` even though the deployment's downloader is yt-dlp: the bytes are already here.
	expect(assignParams('fetch', local, settings_FetchChain({ defaultFetcher: 'ytdlp' })).fetcher).toBe('local');
});

test('a fetch job carries no separator params — it produces nothing singable', () => {
	const p = assignParams('fetch', media_FetchChain(), settings_FetchChain());
	expect(p.engine).toBeUndefined();
	expect(p.model).toBeUndefined();
});

test('a fetch carries the LOOKUP KEYS too — annotation runs as its final step', () => {
	// An absent key is the signal to DECLINE rather than search MusicBrainz on a guess — the same
	// confidence gate as an align job's LRCLIB lookup.
	const p = assignParams(
		'fetch',
		media_FetchChain({ artistCanonical: 'a-ha', titleCanonical: 'Take On Me' }),
		settings_FetchChain()
	);
	expect(p.artist).toBe('a-ha');
	expect(p.track).toBe('Take On Me');
	expect(p.durationSec).toBe(225);
});

test('an unconfident parse sends NO lookup keys to ALIGN, so the worker declines instead of guessing', () => {
	const p = assignParams('align', media_FetchChain(), settings_FetchChain()); // no canonicals set
	expect(p.artist).toBeUndefined();
	expect(p.track).toBeUndefined();
	expect(p.fetcher).toBe('ytdlp'); // the fetcher is still declared — that is not a lookup key
});

test('a fetch DOES send the unconfident guess — MusicBrainz is the gate, not the parser', () => {
	// Verbatim from the live library. `cleanTitleNoise` strips the trailing tag, leaving a title with no separator, so the
	// parser falls back to the uploader, marks itself `low`, and stores no canonicals. A shared gate then means no keys,
	// no MusicBrainz call, and a TV rendering the whole upload string — even though the uploader IS the credited artist.
	const yt = media_FetchChain({
		title: 'Legends Never Die (ft. Against The Current) [OFFICIAL AUDIO] | Worlds 2017 - League of Legends',
		artist: 'League of Legends',
		durationSec: 179
	});
	const p = assignParams('fetch', yt, settings_FetchChain());
	expect(p.artist).toBe('League of Legends');
	// The guest credit is lifted OUT of the song name: MusicBrainz returns zero results for a title with
	// "(ft. …)" still in it.
	expect(p.track).toBe('Legends Never Die');
	expect(p.durationSec).toBe(179);
	// No `artistCredit`: only align reads it, to rank lyrics records. Annotate takes artist/track/
	// durationSec alone, and MusicBrainz returns the full billing itself.
	expect(p.artistCredit).toBeUndefined();
	// align still refuses to guess: LRCLIB answers with its nearest record rather than declining, and
	// that is another song's words.
	expect(assignParams('align', yt, settings_FetchChain()).artist).toBeUndefined();
});

test('a fetch does NOT guess from an aggregator uploader — "7clouds" is not an artist', () => {
	// `unparsed` means there is nothing to send: asking MusicBrainz about a channel name is a wasted paced request.
	const p = assignParams('fetch', media_FetchChain({ title: 'Wake Me Up', artist: '7clouds' }), settings_FetchChain());
	expect(p.artist).toBeUndefined();
	expect(p.track).toBeUndefined();
});

test('a fetch sends no track without an artist — the worker needs both or it declines', () => {
	const p = assignParams('fetch', media_FetchChain(), settings_FetchChain()); // 'Take On Me', no uploader → unparsed
	expect(p.artist).toBeUndefined();
	expect(p.track).toBeUndefined();
});

test('a CONFIDENT canonical is never overwritten by the guess', () => {
	const p = assignParams(
		'fetch',
		media_FetchChain({
			title: 'a-ha - Take On Me (Official Video)',
			artist: 'SomeChannel',
			artistCanonical: 'a-ha',
			titleCanonical: 'Take On Me'
		}),
		settings_FetchChain()
	);
	expect(p.artist).toBe('a-ha');
	expect(p.track).toBe('Take On Me');
});

const settings_UpgradeChain = (o: Partial<GlobalSettings> = {}): GlobalSettings => ({
	...DEFAULT_GLOBAL_SETTINGS,
	defaultModel: 'htdemucs',
	...o
});

function media_UpgradeChain(o: Partial<Media> = {}): Media {
	return {
		id: 'm1',
		source: 'youtube',
		sourceRef: 'abc',
		title: 't',
		durationSec: 100,
		stemStatus: 'none',
		...o
	} as Media;
}

test('quality ranks order the ladder and unranked pairs score zero', () => {
	expect(qualityRank('demucs', 'htdemucs')).toBeLessThan(qualityRank('demucs', 'htdemucs_ft'));
	expect(qualityRank('demucs', 'htdemucs_ft')).toBeLessThan(qualityRank('roformer', 'bs-roformer-1297'));
	expect(qualityRank('roformer', 'bs-roformer-1297')).toBeLessThan(qualityRank('ensemble', 'instrumental_clean'));
	expect(qualityRank('demucs', 'bogus')).toBe(0);
});

test('isQualityUpgrade requires strictly better and treats missing current as upgradeable', () => {
	const fast = { engine: 'demucs', model: 'htdemucs' };
	const better = { engine: 'demucs', model: 'htdemucs_ft' };
	expect(isQualityUpgrade(fast, better)).toBe(true);
	expect(isQualityUpgrade(better, fast)).toBe(false); // never regress
	expect(isQualityUpgrade(better, better)).toBe(false); // equal is a no-op
	expect(isQualityUpgrade(null, fast)).toBe(true);
	expect(isQualityUpgrade(fast, { engine: 'demucs', model: 'bogus' })).toBe(false);
});

test('a process chains align, and the upgrade only when it would improve quality', () => {
	expect(followUps('stems', settings_UpgradeChain())).toEqual(['align']); // upgrade disabled
	expect(followUps('stems', settings_UpgradeChain({ enqueueUpgrade: true }))).toEqual(['align', 'stems-upgrade']);
	// Enabled, but the "upgrade" is not better — so not enqueued, and no wasted 40-minute process.
	expect(
		followUps(
			'stems',
			settings_UpgradeChain({ enqueueUpgrade: true, upgradeEngine: 'demucs', upgradeModel: 'htdemucs' })
		)
	).toEqual(['align']);
});

test('an upgrade job chains nothing further (depth-1 fan-out)', () => {
	expect(followUps('stems-upgrade', settings_UpgradeChain({ enqueueUpgrade: true }))).toEqual([]);
	expect(followUps('align', settings_UpgradeChain())).toEqual([]);
});

test('separatorFor reports the pairing a separation job used, and nothing for others', () => {
	expect(separatorFor('stems', settings_UpgradeChain({ defaultModel: 'htdemucs_ft' }))).toEqual({
		engine: 'demucs',
		model: 'htdemucs_ft'
	});
	expect(separatorFor('stems-upgrade', settings_UpgradeChain())).toEqual({
		engine: 'roformer',
		model: 'bs-roformer-1297'
	});
	expect(separatorFor('align', settings_UpgradeChain())).toBeUndefined();
});

test('a first process publishes and records its separator', () => {
	const byId = new Map([['m1', media_UpgradeChain()]]);
	expect(
		markMediaReady('m1', byId, '/abs/derived/stems/m1-instrumental.flac', { engine: 'demucs', model: 'htdemucs' })
	).toBe(true);
	const m = byId.get('m1')!;
	expect(m.stemStatus).toBe('ready');
	expect(m.separator).toEqual({ engine: 'demucs', model: 'htdemucs' });
});

test('a BETTER upgrade replaces the instrumental and its provenance', () => {
	const byId = new Map([
		[
			'm1',
			media_UpgradeChain({
				stemStatus: 'ready',
				lyricsStatus: 'ready',
				instrumentalRef: 'derived/stems/m1-instrumental.flac',
				separator: { engine: 'demucs', model: 'htdemucs' }
			})
		]
	]);
	expect(
		markMediaReady('m1', byId, '/abs/derived/stems/m1-instrumental.flac', {
			engine: 'roformer',
			model: 'bs-roformer-1297'
		})
	).toBe(true);
	expect(byId.get('m1')!.separator).toEqual({ engine: 'roformer', model: 'bs-roformer-1297' });
});

test('THE INVARIANT: a worse or equal result never replaces a published instrumental', () => {
	const published = { engine: 'roformer', model: 'bs-roformer-1297' };
	const byId = new Map([
		[
			'm1',
			media_UpgradeChain({
				stemStatus: 'ready',
				lyricsStatus: 'ready',
				instrumentalRef: 'derived/stems/m1-instrumental.flac',
				separator: published
			})
		]
	]);
	// A worse engine's result arriving late (a re-queued plain process) is refused.
	expect(
		markMediaReady('m1', byId, '/abs/derived/stems/m1-instrumental.flac', { engine: 'demucs', model: 'htdemucs' })
	).toBe(false);
	expect(byId.get('m1')!.separator).toEqual(published); // unchanged
	// An identical re-process is a no-op rather than a churn.
	expect(markMediaReady('m1', byId, '/abs/derived/stems/m1-instrumental.flac', published)).toBe(false);
});

test('a plain process with no separator reported still publishes (older worker path)', () => {
	const byId = new Map([['m1', media_UpgradeChain()]]);
	expect(markMediaReady('m1', byId, '/abs/derived/stems/m1-instrumental.flac')).toBe(true);
	expect(byId.get('m1')!.stemStatus).toBe('ready');
});
