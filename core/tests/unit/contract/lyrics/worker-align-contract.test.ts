// CROSS-LANGUAGE CONTRACT (review M3, M15): the worker's align completion, as core reads it. The fixture beside this
// test is WRITTEN BY THE WORKER (worker/tests/test_core_contract.py) from its real `run_align`, its real frame builder
// and its real `diarize` step, and it records what the worker MEANT: which candidate it chose, which texts are claims,
// which singer each line belongs to. This test feeds each frame through the same `validateWorkerMessage` →
// `setMediaLyrics` path a live completion takes, and each document through the TV's `parseLyricsDoc`, and asserts
// core realizes that meaning.
//
// Both defects were contracts each side kept on its own and broke between them: the worker sent its TIMING grade as
// `textConfidence` and reported its rejected attempts as peers, so `pickBestLyrics` showed a machine caption as
// authoritative "Captions" and the attempts the ladder had thrown away; and diarization wrote `speaker` where the TV
// reads `part`, so no duet was ever coloured. NEVER hand-edit the JSON: regenerate it from the worker
// (`cd worker && .venv/bin/python -m tests.test_core_contract`), whose own test fails while it is stale.
import { test, expect } from 'bun:test';
import { read } from '$test';
import {
	type LyricsCandidate,
	type Media,
	isAuthoritativeText,
	lyricsRank,
	lyricsSourceLabel,
	parseLyricsCandidates,
	pickBestLyrics,
	duetPartColors
} from '$lib/contract';
import { setMediaLyrics } from '$lib/server/jobs/process';
import { validateWorkerMessage } from '$lib/server/jobs/worker-hub';
import { parseLyricsDoc } from '$lib/tv/lyrics';

interface Frame {
	type: string;
	workerId: string;
	jobId: string;
	mediaUri: string;
	artifacts?: { lyrics?: { uri: string; candidates?: unknown } };
}

interface FrameCase {
	name: string;
	why: string;
	frame: Frame;
	/** What the worker meant: the one candidate it chose (null = it published nothing), its claims, and the
	 *  earlier jobs' candidates it withdrew (words its gate just refused). */
	intent: { chosen: string | null; authoritative: string[]; withdrawn: string[] };
}

interface DocumentCase {
	name: string;
	doc: unknown;
	/** The part the worker attributed each line to, in document order; null = unattributed. */
	parts: (string | null)[];
}

interface Fixture {
	generator: string;
	frames: FrameCase[];
	documents: DocumentCase[];
}

const fixture = JSON.parse(read('tests/unit/contract/lyrics/worker-align-contract.json')) as Fixture;

const frame = (name: string): FrameCase => {
	const found = fixture.frames.find((f) => f.name === name);
	if (!found) throw new Error(`the worker fixture has no frame '${name}' — regenerate it, or update this test`);
	return found;
};

const media = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'A song',
	durationSec: 200,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: 'derived/stems/m1-instrumental.flac',
	...over
});

/** A live completion's lyrics half, exactly as `WorkerHub.#completeVerified` applies it. */
function complete(m: Media, f: Frame): void {
	expect(validateWorkerMessage(f)).toBeNull();
	setMediaLyrics(m.id, f.artifacts?.lyrics?.uri, new Map([[m.id, m]]), f.artifacts?.lyrics?.candidates);
}

const stored = (m: Media, ref: string): LyricsCandidate => {
	const c = m.lyricsCandidates?.find((x) => x.ref === ref);
	if (!c) throw new Error(`${ref} was not stored`);
	return c;
};

test('the fixture covers every ladder shape core used to misread', () => {
	expect(fixture.generator).toBe('worker/tests/test_core_contract.py');
	expect(fixture.frames.map((f) => f.name)).toEqual([
		'line-sync-after-a-rejected-word-attempt',
		'a-worse-retry-loses-to-the-attempt-it-retried',
		'machine-captions-word-doc',
		'no-lyrics-after-an-unusable-transcript',
		'a-pinned-paste',
		'a-refused-text-withdraws-an-earlier-jobs-candidate',
		'a-re-picked-machine-caption',
		'a-re-picked-transcript',
		'a-doubt-band-word-document',
		'a-pin-the-lexical-gate-refused'
	]);
	expect(fixture.documents.map((d) => d.name)).toEqual(['a-duet', 'an-over-segmented-solo']);
});

test("every frame: core shows the worker's choice, stores every candidate, and reads each text's standing", () => {
	for (const { name, frame: f, intent } of fixture.frames) {
		const m = media();
		complete(m, f);
		const reported = parseLyricsCandidates(f.artifacts?.lyrics?.candidates);
		// EVERY candidate is stored, rejected or not: retention enumerates its cleanup set from these refs.
		expect(m.lyricsCandidates?.map((c) => c.ref).sort(), name).toEqual(reported.map((c) => c.ref).sort());
		expect(m.lyricsRef ?? null, name).toBe(intent.chosen);
		for (const c of m.lyricsCandidates ?? []) {
			expect(isAuthoritativeText(c), `${name}: ${c.ref}`).toBe(intent.authoritative.includes(c.ref));
			// Only the worker's choice is auto-selectable; a rejected attempt ranks 0 whatever it looks like.
			expect(lyricsRank(c) > 0, `${name}: ${c.ref}`).toBe(c.ref === intent.chosen);
		}
	}
});

test('a line-synced sheet is shown over the word attempt its ladder rejected (review M3)', () => {
	const m = media();
	complete(m, frame('line-sync-after-a-rejected-word-attempt').frame);
	const line = stored(m, 'derived/lyrics/m1-lrclib-line-sync-line.json');
	// Its words are the sheet's (authoritative), its timing grade is low: two axes, no longer one.
	expect([line.textConfidence, line.timingConfidence, lyricsRank(line)]).toEqual(['high', 'low', 4]);
	expect(lyricsRank(stored(m, 'derived/lyrics/m1-lrclib-word.json'))).toBe(0);
	expect(m.lyricsRef).toBe(line.ref);
});

test('within one report the selectable flag decides, not list order or a shared createdAt', () => {
	const { frame: f, intent } = frame('a-worse-retry-loses-to-the-attempt-it-retried');
	const reported = parseLyricsCandidates(f.artifacts?.lyrics?.candidates);
	expect(new Set(reported.map((c) => c.createdAt)).size).toBe(1);
	expect(pickBestLyrics(reported)?.ref).toBe(intent.chosen!);
	expect(pickBestLyrics([...reported].reverse())?.ref).toBe(intent.chosen!);
});

test('a machine-caption word doc is not authoritative: "Auto captions", below a line-synced sheet (review M3)', () => {
	const m = media();
	complete(m, frame('line-sync-after-a-rejected-word-attempt').frame);
	complete(m, frame('machine-captions-word-doc').frame); // a later job, a worse text
	const machine = stored(m, 'derived/lyrics/m1-captions-machine-word.json');
	expect(isAuthoritativeText(machine)).toBe(false);
	expect(lyricsSourceLabel(machine)).toBe('Auto captions');
	// NEVER-REGRESS across jobs still holds: authoritative + line (4) outranks unauthoritative + word (3).
	expect(m.lyricsRef).toBe('derived/lyrics/m1-lrclib-line-sync-line.json');
});

test('a job that published nothing shows nothing it wrote, and leaves an earlier choice standing', () => {
	const { frame: f } = frame('no-lyrics-after-an-unusable-transcript');
	const fresh = media();
	complete(fresh, f);
	expect(fresh.lyricsRef).toBeUndefined();
	expect(fresh.lyricsCandidates).toHaveLength(1); // still nameable for retention

	const earlier = media();
	complete(earlier, frame('machine-captions-word-doc').frame);
	complete(earlier, f);
	expect(earlier.lyricsRef).toBe('derived/lyrics/m1-captions-machine-word.json');
});

test('a pointer to a file a later job rewrote with a reject is cleared, not shown', () => {
	// A re-run's first attempt reuses the ref its predecessor published under, and here was rejected.
	const { frame: f } = frame('no-lyrics-after-an-unusable-transcript');
	const rewritten = parseLyricsCandidates(f.artifacts?.lyrics?.candidates)[0]!.ref;
	const m = media({
		lyricsRef: rewritten,
		lyricsCandidates: [{ ref: rewritten, textSource: 'asr', timing: 'word', textConfidence: 'low', createdAt: 1 }]
	});
	complete(m, f);
	expect(m.lyricsRef).toBeUndefined();
	// A pointer naming anything else is left alone, as a set with nothing showable always has.
	const other = media({ lyricsRef: 'derived/lyrics/m1-good.json' });
	complete(other, f);
	expect(other.lyricsRef).toBe('derived/lyrics/m1-good.json');
});

test('a text the ladder refused withdraws the candidate an earlier job stored for it (review W1 r2)', () => {
	// The earlier job published the sheet as a word doc: authoritative + word, rank 5. The re-align's gate refused
	// the same words, which writes nothing, so without the withdrawal the stored entry kept its rank and was shown
	// over the transcript this job chose (rank 3).
	const { frame: f, intent } = frame('a-refused-text-withdraws-an-earlier-jobs-candidate');
	const [withdrawn] = intent.withdrawn;
	const earlier: LyricsCandidate = {
		ref: withdrawn!,
		textSource: 'lrclib',
		timing: 'word',
		textConfidence: 'high',
		timingConfidence: 'high',
		createdAt: 1
	};
	expect(lyricsRank(earlier)).toBe(5);
	const m = media({ lyricsRef: earlier.ref, lyricsCandidates: [earlier] });
	complete(m, f);
	expect(lyricsRank(stored(m, earlier.ref))).toBe(0);
	expect(stored(m, earlier.ref).selectable).toBe(false);
	expect(m.lyricsRef).toBe(intent.chosen!);
	// Withdrawn from the RANKING only: a person who picks it still gets it.
	const pinned = media({ lyricsOverrideRef: earlier.ref, lyricsCandidates: [earlier] });
	complete(pinned, f);
	expect(pinned.lyricsRef).toBe(earlier.ref);
});

test("a person's pick of a rejected attempt still holds: selectable gates the RANKING, not the override", () => {
	const { frame: f } = frame('line-sync-after-a-rejected-word-attempt');
	const m = media({ lyricsOverrideRef: 'derived/lyrics/m1-lrclib-word.json' });
	complete(m, f);
	expect(m.lyricsRef).toBe('derived/lyrics/m1-lrclib-word.json');
});

test('a pasted pin is a claim: "Your lyrics", authoritative, and the one candidate', () => {
	const { frame: f, intent } = frame('a-pinned-paste');
	const m = media({ lyricsOverrideRef: intent.chosen! });
	complete(m, f);
	const paste = stored(m, intent.chosen!);
	expect([paste.textSource, paste.textConfidence, lyricsSourceLabel(paste)]).toEqual(['manual', 'high', 'Your lyrics']);
	expect(m.lyricsRef).toBe(intent.chosen!);
});

test("a person's re-pick is sent as their claim, whatever the text's tier (W3: the old worker's pin)", () => {
	// W1 sent a re-timed machine track `low` (its tier), so the words a person had just chosen still read as
	// "Auto captions", not verified. A pin's words are `high` now; the source still says what the text is.
	const machine = frame('a-re-picked-machine-caption');
	const m = media({ lyricsOverrideRef: machine.intent.chosen! });
	complete(m, machine.frame);
	const repicked = stored(m, machine.intent.chosen!);
	expect([repicked.textSource, repicked.textConfidence, lyricsSourceLabel(repicked)]).toEqual([
		'captions',
		'high',
		'Captions'
	]);
	expect(isAuthoritativeText(repicked)).toBe(true);
	expect(m.lyricsRef).toBe(machine.intent.chosen!);
	// A transcript is sent `high` like every pin, and is still no claim: core never counts `asr` words as one.
	const transcript = frame('a-re-picked-transcript');
	const t = media({ lyricsOverrideRef: transcript.intent.chosen! });
	complete(t, transcript.frame);
	const heard = stored(t, transcript.intent.chosen!);
	expect([heard.textSource, heard.textConfidence, lyricsSourceLabel(heard)]).toEqual([
		'asr',
		'high',
		'Auto-transcribed'
	]);
	expect(isAuthoritativeText(heard)).toBe(false);
});

test('a doubt-band word doc is no claim, and loses to a vouched line-timed rival (W3 r1)', () => {
	// The worker published it, but its lexical lift says nothing vouches for the WORDS. Sent as the timing
	// grade alone (`timingConfidence: medium`) it read authoritative + word = rank 5, tied with a fully vouched
	// word doc and above a CORRECT line-timed sheet — this band's grade is `medium`, and `lyricsRank` read
	// `timingConfidence` nowhere before W6 and demotes only on a `low` one since, so neither version of that
	// ranking could have carried the doubt.
	// The doubt rides on `vouched`, not `textConfidence`: that field is the text's PROVENANCE (W3 r2).
	const m = media();
	complete(m, frame('line-sync-after-a-rejected-word-attempt').frame); // an earlier job's vouched sheet
	complete(m, frame('a-doubt-band-word-document').frame);
	const doubted = stored(m, frame('a-doubt-band-word-document').intent.chosen!);
	expect([doubted.vouched, doubted.textConfidence, doubted.timingConfidence, doubted.timing]).toEqual([
		false,
		'high',
		'medium',
		'word'
	]);
	expect(isAuthoritativeText(doubted)).toBe(false);
	expect(lyricsRank(doubted)).toBe(3);
	expect(m.lyricsRef).toBe('derived/lyrics/m1-lrclib-line-sync-line.json'); // authoritative + line = 4
});

test('a doubted caption track is still labelled "Captions", not "Auto captions" (W3 r2)', () => {
	// The mislabelling the `vouched` field exists to avoid: `textConfidence: low` is how core knows a caption
	// track is MACHINE-generated, so sending the words' doubt there told the room an uploader's hand-authored
	// track was auto-generated — false about where the text came from, which is not what the gate measured.
	const authored: LyricsCandidate = {
		ref: 'derived/lyrics/m1-captions-authored-word.json',
		textSource: 'captions',
		timing: 'word',
		textConfidence: 'high',
		vouched: false,
		createdAt: 1
	};
	expect(lyricsSourceLabel(authored)).toBe('Captions');
	expect(isAuthoritativeText(authored)).toBe(false);
	expect(lyricsRank(authored)).toBe(3);
	// A machine track is `low` by its tier, as it always was, and reads as what it is.
	expect(lyricsSourceLabel({ ...authored, textConfidence: 'low' })).toBe('Auto captions');
});

test('a pin the lexical gate refused still shows, but not as a claim (W3 r1)', () => {
	// A person chose the words, so the worker publishes them and core's override keeps showing them — what it
	// must NOT do is read them as verified: the pin's usual `high` would make unmeasured words authoritative.
	const { frame: f, intent } = frame('a-pin-the-lexical-gate-refused');
	const m = media({ lyricsOverrideRef: intent.chosen! });
	complete(m, f);
	const pin = stored(m, intent.chosen!);
	expect([pin.textSource, pin.textConfidence, pin.vouched, lyricsSourceLabel(pin)]).toEqual([
		'manual',
		'high',
		false,
		'Your lyrics'
	]);
	expect(isAuthoritativeText(pin)).toBe(false);
	expect(m.lyricsRef).toBe(intent.chosen!); // the override is above the ranking, as always
});

test("a duet's parts reach the TV line for line, and an over-segmented solo stays one colour (review M15)", () => {
	for (const { name, doc, parts } of fixture.documents) {
		const parsed = parseLyricsDoc(doc);
		expect(parsed, name).not.toBeNull();
		expect(
			parsed!.lines.map((l) => l.part ?? null),
			name
		).toEqual(parts);
		const colours = duetPartColors(parsed!.lines);
		expect(colours.size, name).toBe(new Set(parts.filter((p) => p !== null)).size);
	}
	expect(fixture.documents.find((d) => d.name === 'a-duet')!.parts).toContain('B');
});

// ── the parser, on shapes the worker fixture does not carry ──────────────────────────────────────────────────

test('an OLD candidate parses unchanged: every field added since is optional', () => {
	const old = {
		ref: 'derived/lyrics/m1-lrclib-word.json',
		textSource: 'lrclib',
		timing: 'word',
		textConfidence: 'high',
		timingConfidence: 'medium',
		language: 'en',
		createdAt: 5,
		agreement: 0.9,
		coverage: 0.8
	};
	expect(parseLyricsCandidates([old])).toEqual([old as LyricsCandidate]);
	expect(lyricsRank(parseLyricsCandidates([old])[0]!)).toBe(5);
});

test('unknown fields are dropped and unreadable values fail SAFE, but a candidate with a ref is kept', () => {
	const [c] = parseLyricsCandidates([
		{ ref: 'derived/lyrics/x.json', textSource: 'genius', timing: 'syllable', textConfidence: 'certain', extra: 1 }
	]);
	// Kept, because its ref is a file retention must still be able to name; never authoritative, never shown.
	expect(c).toEqual({
		ref: 'derived/lyrics/x.json',
		textSource: 'asr',
		timing: 'none',
		textConfidence: 'low',
		createdAt: 0
	});
	expect(lyricsRank(c!)).toBe(0);
	expect(parseLyricsCandidates([{ textSource: 'lrclib' }, null, 7, 'x', { ref: '' }])).toEqual([]);
	expect(parseLyricsCandidates('not a list')).toEqual([]);
	expect(parseLyricsCandidates(undefined)).toEqual([]);
});

test("a v2 document's raw diarizer `speaker` is NOT read as a part (it was written with no duet checks)", () => {
	const parsed = parseLyricsDoc({
		lines: [
			{ text: 'one', start: 0, end: 1, speaker: 'SPEAKER_00' },
			{ text: 'two', start: 2, end: 3, speaker: 'SPEAKER_01' }
		]
	});
	expect(parsed!.lines.map((l) => l.part)).toEqual([undefined, undefined]);
});
