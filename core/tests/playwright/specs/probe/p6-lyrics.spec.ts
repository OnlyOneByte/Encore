/*
 * P6 — WORD-TIMED LYRICS OVERLAY.
 *
 * THE FIXTURE CAN LOOK LIKE THE BUG. Every timing signal comes from the artifact the fake worker writes, so the
 * schema agreement is checked FIRST, and against the file the worker actually wrote rather than against a copy
 * of its shape — the old probe found the shipped fixture writing {startSec,endSec,text} where the TV parser
 * reads {start,end,word}, which dropped every word, left `activeLineIndex` at 0 forever, and made a healthy
 * overlay read as broken. world/workers.ts writes the parser's shape now, and the test below is what keeps it
 * doing that. The expected word table is DERIVED from the artifact on disk for the same reason: a hand-copied
 * table is a second fixture that can drift from the first.
 *
 * TWO SONGS ARE QUEUED, not one: the demo fixture is 8 seconds long, and the overlay exists only while a song
 * is on stage outside the intro card, so a single track leaves no room to flip a setting and watch it land.
 */
import { test, expect, type World } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker, type FakeWorker } from '../../world/workers';
import { queueReady } from '../../world/actors';
import { parseLyricsDoc } from '$lib/tv/lyrics';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

/** The two demo tracks this probe queues, in rotation order. */
const SONGS = ['caroline', 'believin'];
/** LYRICS_LEAD_SEC puts the ball on a word BEFORE the audio, so a healthy lag is ≈ +300..+700ms. Roomy on both
 *  sides: near 0 means no lead, negative means late, and the width is sampling jitter. */
const LAG_MIN_MS = -100;
const LAG_MAX_MS = 900;
/** 1080p is read from ~10 feet and --tv-lyric sits at 60-90px, so under this is unreadable. */
const MIN_LINE_PX = 40;
/** Black stage, white/amber ink clear 4.5:1 by construction, so the AAA 7:1 threshold is what catches an
 *  accidental drop to a mid-grey. */
const MIN_CONTRAST = 7;
/** The tracking series: the old probe's own cadence and window. */
const SAMPLE_MS = 300;
const SAMPLE_COUNT = 20;
const SAMPLE_WINDOW_MS = 6_500;

interface SongRow {
	id: string;
	title: string;
	source: string;
	instrumentalRef?: string | null;
	lyricsRef?: string | null;
}
interface SearchBody {
	ready: SongRow[];
	processing: SongRow[];
	results: SongRow[];
}

/**
 * Process one local library song and resolve when its ALIGN artifact has landed — `lyricsRef`, not merely ready:
 * the overlay is what this probe is about.
 *
 * `awaitDemoTrack` first, because the library scan is a detached boot pass and the index is empty for seconds
 * after `/health` answers.
 */
async function processWithLyrics(world: World, page: Page, query: string): Promise<SongRow> {
	const track = await world.awaitDemoTrack(query);
	const res = await page.request.post('/api/process', { data: { mediaId: track.id } });
	if (!res.ok()) throw new Error(`/api/process refused "${query}": ${res.status()} ${await res.text()}`);
	let ready: SongRow | undefined;
	await expect
		.poll(
			async () => {
				const body = (await page.request
					.get(`/api/search?q=${encodeURIComponent(query)}`)
					.then((r) => r.json())) as SearchBody;
				ready = body.ready.find((r) => r.id === track.id && !!r.instrumentalRef && !!r.lyricsRef);
				return !!ready;
			},
			{ timeout: 60_000, message: `"${track.title}" never reached ready with a lyrics ref` }
		)
		.toBe(true);
	return ready as SongRow;
}

interface Stage {
	phone: Page;
	tv: Page;
	worker: FakeWorker;
	/** Absolute path of the first song's align artifact, for the fixture and empty-artifact claims. */
	lyricsPath: string;
	/** The word table the TV should be following, read off the artifact the worker wrote. */
	words: { word: string; start: number; end: number }[];
}

/**
 * A room with two processed songs on the rotation and a TV playing the first, presentation settings at the
 * values the marker claims need.
 *
 * It does NOT wait for the reel: that is P6-1's claim, and every other test asserts it as its own precondition.
 */
async function lyricsStage(world: World): Promise<Stage> {
	const worker = await startFakeWorker(world);
	const phone = await world.openPhone('P6Phone');
	await world.becomeHost(phone);
	const first = await processWithLyrics(world, phone, SONGS[0]);
	await processWithLyrics(world, phone, SONGS[1]);
	for (const q of SONGS) await queueReady(phone, q);

	// highlight=word and ball=bounce are preconditions for the marker claims; font/case are set so a test that
	// flips one is comparing against a known value.
	await putRoom(phone, { lyricsHighlight: 'word', lyricsBall: 'bounce', lyricsFont: 'system', lyricsCase: 'natural' });
	await putGlobal(phone, { syncMode: 'forced' });

	const tv = await world.openTv();
	await tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
	// ONE REAL TAP, so the document is authorised the way a room authorises it rather than by relaxing a policy
	// for a browser no television ships as. Every claim below needs a playhead that is actually moving.
	await tv.mouse.click(960, 540);

	if (!first.lyricsRef) throw new Error(`"${first.title}" reported ready with no lyricsRef`);
	const lyricsPath = join(world.mediaDir, first.lyricsRef);
	const doc = parseLyricsDoc(JSON.parse(readFileSync(lyricsPath, 'utf8')));
	if (!doc || doc.words.length === 0) {
		throw new Error(`the align artifact at ${lyricsPath} parsed to no words, so no timing claim has a subject`);
	}
	return { phone, tv, worker, lyricsPath, words: doc.words };
}

async function putRoom(page: Page, body: Record<string, unknown>): Promise<void> {
	// Through the PHONE's request context, which holds the host session the stage unlocked.
	const res = await page.request.put('/api/settings/room', { data: body });
	if (!res.ok()) throw new Error(`PUT /api/settings/room ${JSON.stringify(body)} -> ${res.status()}`);
}
async function putGlobal(page: Page, body: Record<string, unknown>): Promise<void> {
	const res = await page.request.put('/api/settings', { data: body });
	if (!res.ok()) throw new Error(`PUT /api/settings ${JSON.stringify(body)} -> ${res.status()}`);
}

/** The overlay's live presentation state. `null` for the whole reading when no reel is on stage, so a caller
 *  polling through the between-songs intro card retries rather than recording a false absence. */
interface OverlayClasses {
	hlClass: string | null;
	ballClass: string | null;
	ballPresent: boolean;
	/** A dot marker is DRAWN, since the TV draws no `●` (stage-words.test.ts): a square box, round and filled. */
	ballDrawn: boolean;
	/** Where the marker sits on its word: `dx` its centre off the word's centre in px, `cy` and `bottom` its centre
	 *  and bottom below the word box's top, in the word's em. */
	ballPlace: { dx: number; cy: number; bottom: number } | null;
	fontFamily: string | null;
	textTransform: string | null;
	unverified: boolean;
}
async function readClasses(tv: Page): Promise<OverlayClasses | null> {
	return tv.evaluate(
		({ lyrics, rowCurrent, ball }) => {
			const l = document.querySelector(lyrics);
			if (!l) return null;
			const w = document.querySelector(rowCurrent);
			const cs = w ? getComputedStyle(w) : null;
			const b = document.querySelector(ball);
			const bs = b ? getComputedStyle(b) : null;
			const bw = Math.round(parseFloat(bs?.width ?? ''));
			const word = b?.parentElement;
			const place = () => {
				const r = b!.getBoundingClientRect();
				const wr = word!.getBoundingClientRect();
				const em = parseFloat(getComputedStyle(word!).fontSize);
				return {
					dx: r.x + r.width / 2 - (wr.x + wr.width / 2),
					cy: (r.y + r.height / 2 - wr.y) / em,
					bottom: (r.bottom - wr.y) / em
				};
			};
			return {
				ballPlace: b && word ? place() : null,
				ballDrawn:
					!!bs &&
					bw > 8 &&
					Math.round(parseFloat(bs.height)) === bw &&
					bs.borderRadius === '50%' &&
					bs.backgroundColor !== 'rgba(0, 0, 0, 0)',
				hlClass: [...l.classList].find((c) => c.startsWith('hl-')) ?? null,
				ballClass: b ? ([...b.classList].find((c) => ['bounce', 'steady', 'underline'].includes(c)) ?? null) : null,
				ballPresent: !!b,
				fontFamily: cs?.fontFamily ?? null,
				textTransform: cs?.textTransform ?? null,
				unverified: l.classList.contains('unverified')
			};
		},
		{ lyrics: SEL.lyrics, rowCurrent: SEL.lyricsRowCurrent, ball: SEL.ball }
	);
}

/** One field of the reading, polled — `null` while the intro card is up, which is why every marker claim is a
 *  poll and not a single sample. The ball is the sharpest case: it mounts only under an ACTIVE word, and words
 *  are ~0.7s wide with ~0.1s gaps, so one sample can catch a gap and report a present marker as absent. */
function overlayField<K extends keyof OverlayClasses>(tv: Page, key: K): () => Promise<OverlayClasses[K] | null> {
	return async () => (await readClasses(tv))?.[key] ?? null;
}

test('the lyrics overlay renders once the align artifact is available, without a reload', async ({ world }) => {
	const stage = await lyricsStage(world);
	try {
		// The wait is long because the play-when-queued path and the 'Next up' intro card both delay it — and
		// nothing reloads the TV between the song arriving and this.
		await expect(
			stage.tv.locator(SEL.lyrics),
			'no .lyrics element ever appeared on /tv while a processed song with a lyricsRef was current'
		).toBeAttached({
			timeout: 25_000
		});
		await expect(stage.tv.locator(SEL.lyricsRow).first()).toBeAttached();
	} finally {
		await stage.worker.stop();
	}
});

test('the align artifact this suite writes uses the field names the TV parser reads', async ({ world }) => {
	const worker = await startFakeWorker(world);
	const phone = await world.openPhone('P6Schema');
	try {
		const song = await processWithLyrics(world, phone, SONGS[0]);
		const raw: unknown = JSON.parse(readFileSync(join(world.mediaDir, song.lyricsRef as string), 'utf8'));
		const parsed = parseLyricsDoc(raw);
		expect(
			parsed && parsed.lines.length > 0 && parsed.lines.every((l) => l.words.length > 0),
			`the worker's own align artifact parses to no words: ${JSON.stringify(raw).slice(0, 200)} — every word ` +
				`entry would be dropped by parseLyricsDoc, line bounds would resolve to null and activeLineIndex would ` +
				`return 0 forever, which reads as an overlay defect when the FIXTURE is what is wrong`
		).toBe(true);
		expect(
			parsed?.lines.every((l) => l.start !== null && l.end !== null),
			'the artifact parses to lines with null bounds, so no line can ever become current'
		).toBe(true);
		// The check has teeth: the shape the OLD fixture wrote must still be REFUSED, or this test would pass on
		// a parser that accepted anything.
		const wrongShape = parseLyricsDoc({
			lines: [{ startSec: 0, endSec: 1, text: 'x', words: [{ text: 'x', startSec: 0, endSec: 1 }] }]
		});
		expect(
			wrongShape?.lines[0]?.words.length,
			'parseLyricsDoc accepted {startSec,endSec,text}, so this test can no longer tell the two shapes apart'
		).toBe(0);
	} finally {
		await worker.stop();
	}
});

interface TrackSample {
	currentTime: number;
	active: string | null;
	current: string | null;
	reelTransform: string;
}

test('the active word is drawn, walks the line and tracks the audio clock', async ({ world }) => {
	const stage = await lyricsStage(world);
	try {
		await expect(stage.tv.locator(SEL.lyrics)).toBeAttached({ timeout: 25_000 });
		// Back to the top of the song through the REAL transport, so the series starts where the word table does
		// and the 8s fixture is not half spent before the first sample.
		await stage.phone.getByRole(SEL.restart.role, { name: SEL.restart.name }).click();

		const samples: TrackSample[] = [];
		const started = Date.now();
		for (let i = 0; i < SAMPLE_COUNT && Date.now() - started < SAMPLE_WINDOW_MS; i++) {
			samples.push(
				await stage.tv.evaluate(
					({ mediaEl, activeWord, rowCurrent, reel }) => {
						const v = document.querySelector<HTMLMediaElement>(mediaEl);
						const a = document.querySelector(activeWord);
						const c = document.querySelector(rowCurrent);
						const r = document.querySelector(reel);
						// The .word.active span wraps the ball glyph too, so textContent yields the glyph — strip it.
						const strip = (s: string | null | undefined) =>
							s
								? s
										.trim()
										.replace(/^[●·]+\s*/, '')
										.trim()
								: null;
						return {
							currentTime: v ? v.currentTime : -1,
							active: strip(a?.textContent),
							current: strip(c?.textContent),
							reelTransform: r ? getComputedStyle(r).transform : ''
						};
					},
					{ mediaEl: SEL.mediaEl, activeWord: SEL.activeWord, rowCurrent: SEL.lyricsRowCurrent, reel: SEL.lyricsReel }
				)
			);
			await new Promise((r) => setTimeout(r, SAMPLE_MS));
		}

		const withActive = samples.filter((s) => s.active);
		const distinctActive = new Set(withActive.map((s) => s.active)).size;
		const transforms = samples.map((s) => s.reelTransform).filter(Boolean);
		const distinctTransforms = new Set(transforms).size;
		const clockMoved = (samples.at(-1)?.currentTime ?? -1) - (samples[0]?.currentTime ?? -1);
		// Lag = currentTime - word.start, only where the sampled word and the expected one agree. The window is
		// the artifact's OWN spacing — up to the next word's start, and the last word's own end plus the gap —
		// rather than a step copied out of the fixture.
		const expectedAt = (t: number) =>
			stage.words.find((w, i) => {
				const next = stage.words[i + 1];
				return t >= w.start && (next ? t < next.start : t < w.end + 0.1);
			}) ?? null;
		const lags = withActive
			.filter((s) => s.currentTime >= 0)
			.flatMap((s) => {
				const expected = expectedAt(s.currentTime);
				return expected && expected.word.toLowerCase() === s.active?.toLowerCase()
					? [Math.round((s.currentTime - expected.start) * 1000)]
					: [];
			});
		const meanLag = lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : Number.NaN;
		const detail =
			`${samples.length} samples, clock moved ${clockMoved.toFixed(3)}s, ` +
			`${withActive.length} with an active word ${JSON.stringify([...new Set(withActive.map((s) => s.active))])}, ` +
			`${distinctTransforms} distinct reel transforms, lags(ms)=${JSON.stringify(lags)}`;

		// ORDERED BY CAUSE: audio advancing with a frozen reel is one bug, a moving reel over stalled audio is
		// another, and a frozen-reel finding on silent audio is CAUSED by the silence. The upstream claim fails
		// first so the diagnosis is not inverted.
		expect(clockMoved, `the audio clock did not advance during the tracking window — ${detail}`).toBeGreaterThan(1.0);
		expect(
			withActive.length,
			`not once did .word.active exist. All ${samples.length} samples were null — ${detail}`
		).toBeGreaterThan(0);
		expect(
			distinctActive,
			`the bouncing ball never left one word — only ${JSON.stringify([...new Set(withActive.map((s) => s.active))])} ` +
				`was ever active — ${detail}`
		).toBeGreaterThan(1);
		expect(
			distinctTransforms,
			`the reel transform stayed at ${JSON.stringify([...new Set(transforms)])} throughout — a frozen reel with ` +
				`advancing audio — ${detail}`
		).toBeGreaterThan(1);
		expect(
			lags.length,
			`no sample landed on an expected word; the highlight lag cannot be computed — ${detail}`
		).toBeGreaterThan(0);
		expect(meanLag, `the highlight does not track the audio clock — ${detail}`).toBeGreaterThanOrEqual(LAG_MIN_MS);
		expect(meanLag, `the highlight does not track the audio clock — ${detail}`).toBeLessThanOrEqual(LAG_MAX_MS);
	} finally {
		await stage.worker.stop();
	}
});

test('the current line is legible at TV distance: size and contrast', async ({ world }) => {
	const stage = await lyricsStage(world);
	try {
		// ONE reading, at 1920x1080 because the TV's type scale is vh-relative. POLLED until a current line is on
		// stage, not read once after an attach check: the reel can mount for a beat before the opening "Now singing"
		// card unmounts it (`onFirstSongReady`), so a single read can land inside the card and find no line at all.
		type Geom = { currentTextPx: number; currentColor: string; viewportH: number | null; currentText: string };
		let reading: Geom | null = null;
		await expect
			.poll(
				async () => {
					reading = await stage.tv.evaluate(
						({ rowCurrent, viewport }) => {
							const current = document.querySelector(rowCurrent);
							if (!current) return null;
							const cs = getComputedStyle(current);
							return {
								currentTextPx: parseFloat(cs.fontSize),
								currentColor: cs.color,
								viewportH: document.querySelector(viewport)?.getBoundingClientRect().height ?? null,
								currentText: current.textContent?.trim() ?? ''
							};
						},
						{ rowCurrent: SEL.lyricsRowCurrent, viewport: SEL.lyricsViewport }
					);
					return reading !== null;
				},
				{ timeout: 25_000, message: 'no current line was on stage to measure' }
			)
			.toBe(true);
		// Assigned inside the poll, so control flow still types it `null` here.
		const geom = reading as Geom | null;

		expect(
			geom?.currentTextPx,
			`current-line font-size is ${geom?.currentTextPx}px at 1920x1080 — a couch-distance TV needs ` +
				`>=${MIN_LINE_PX}px (reading: ${JSON.stringify(geom)})`
		).toBeGreaterThanOrEqual(MIN_LINE_PX);

		// Against the BLACK stage floor, which is why the divisor is a literal 0 luminance rather than a measured
		// backdrop: the reel paints over the stage, and a mid-grey ink is the regression this catches.
		const rgb = /rgba?\((\d+)[^\d]+(\d+)[^\d]+(\d+)(?:\s*[,/]\s*([\d.]+))?/.exec(geom?.currentColor ?? '');
		expect(rgb, `the ink colour ${geom?.currentColor} is not an rgb() this can measure`).not.toBeNull();
		// A translucent ink composites over the black floor as its channels times alpha.
		const alpha = rgb?.[4] === undefined ? 1 : Number(rgb[4]);
		const linear = [1, 2, 3]
			.map((i) => (Number(rgb?.[i]) / 255) * alpha)
			.map((s) => (s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)));
		const lum = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
		const ratio = (lum + 0.05) / 0.05;
		expect(
			ratio,
			`ink colour ${geom?.currentColor} lands at ${ratio.toFixed(1)}:1 against the stage floor — below the ` +
				`WCAG AAA ${MIN_CONTRAST}:1 target for large text`
		).toBeGreaterThanOrEqual(MIN_CONTRAST);
	} finally {
		await stage.worker.stop();
	}
});

test('transcribed lyrics carry the amber unverified tint and no source label', async ({ world }) => {
	// THE OLD PROBE COULD NOT ASK THIS. Its worker sent no `artifacts.lyrics.candidates`, so `chosenCandidate`
	// returned null, `isAutoTranscribed(null)` was false and the finding was recorded as an ENV LIMIT rather than
	// a defect. world/workers.ts publishes the candidate with `textSource: 'asr'`, so the claim is now real.
	// The room cannot act on WHERE the words came from (proposal 09), so the lower third names no source: the
	// tint alone says "a guess", and the source stays on the singer's phone.
	const stage = await lyricsStage(world);
	try {
		await expect(stage.tv.locator(SEL.lyrics)).toBeAttached({ timeout: 25_000 });
		await expect(stage.tv.locator(SEL.lowerThird), 'the stage never showed its lower third').toBeVisible();
		for (const label of ['Auto-transcribed', 'LRCLIB', 'From the video captions', 'Pasted by hand']) {
			await expect(stage.tv.locator(SEL.lowerThird), `the stage names its lyric source: "${label}"`).not.toContainText(
				label
			);
		}
		await expect(
			stage.tv.locator(SEL.lyricsUnverified),
			'the reel carries no .unverified tint for an ASR-sourced artifact'
		).toBeAttached();
	} finally {
		await stage.worker.stop();
	}
});

test('lyrics-highlight (word / line / off) applies live to the overlay', async ({ world }) => {
	const stage = await lyricsStage(world);
	try {
		await expect(stage.tv.locator(SEL.lyrics)).toBeAttached({ timeout: 25_000 });
		const hl = overlayField(stage.tv, 'hlClass');
		await expect.poll(hl, { message: 'the overlay did not start at hl-word' }).toBe('hl-word');
		await putRoom(stage.phone, { lyricsHighlight: 'line' });
		await expect.poll(hl, { message: 'lyrics-highlight=line did not reach the overlay' }).toBe('hl-line');
		await putRoom(stage.phone, { lyricsHighlight: 'off' });
		await expect.poll(hl, { message: 'lyrics-highlight=off did not reach the overlay' }).toBe('hl-off');
		await putRoom(stage.phone, { lyricsHighlight: 'word' });
		await expect.poll(hl, { message: 'lyrics-highlight=word did not come back' }).toBe('hl-word');
	} finally {
		await stage.worker.stop();
	}
});

test('lyrics-ball (bounce / steady / underline / off) applies live to the marker', async ({ world }) => {
	const stage = await lyricsStage(world);
	try {
		await expect(stage.tv.locator(SEL.lyrics)).toBeAttached({ timeout: 25_000 });
		const ballClass = overlayField(stage.tv, 'ballClass');
		await putRoom(stage.phone, { lyricsBall: 'steady' });
		await expect.poll(ballClass, { message: 'lyrics-ball=steady did not reach the marker' }).toBe('steady');
		// Read in the same frame as the class, and kept: between words there is no marker at all.
		let drawn: boolean | null = null;
		const seen: { place: OverlayClasses['ballPlace'] } = { place: null };
		await expect
			.poll(async () => {
				const c = await readClasses(stage.tv);
				if (c?.ballClass === 'steady') [drawn, seen.place] = [c.ballDrawn, c.ballPlace];
				return drawn;
			})
			.toBe(true);
		// WHERE THE OLD `●` INKED, in the word's em: its centre 0.51 and its bottom 0.745 below the word box's top
		// (the glyph at `top: -0.85em`, measured in this container's font), and centred on the word.
		const at = seen.place!;
		expect(Math.abs(at.dx), `the ball is off the word's centre: ${JSON.stringify(at)}`).toBeLessThanOrEqual(1);
		expect(at.cy, `the ball's centre moved: ${JSON.stringify(at)}`).toBeCloseTo(0.51, 1);
		expect(at.bottom, `the ball's bottom moved: ${JSON.stringify(at)}`).toBeCloseTo(0.745, 1);
		await putRoom(stage.phone, { lyricsBall: 'underline' });
		await expect.poll(ballClass, { message: 'lyrics-ball=underline did not reach the marker' }).toBe('underline');
		await putRoom(stage.phone, { lyricsBall: 'off' });
		// OFF IS AN ABSENCE, and the only one here: the marker renders no element at all.
		await expect
			.poll(async () => (await readClasses(stage.tv))?.ballPresent ?? null, {
				message: 'lyrics-ball=off left a marker on screen'
			})
			.toBe(false);
		await putRoom(stage.phone, { lyricsBall: 'bounce' });
		await expect.poll(ballClass, { message: 'lyrics-ball=bounce did not come back' }).toBe('bounce');
	} finally {
		await stage.worker.stop();
	}
});

test('lyrics-font changes the reel font family live', async ({ world }) => {
	const stage = await lyricsStage(world);
	try {
		await expect(stage.tv.locator(SEL.lyricsRowCurrent)).toBeAttached({ timeout: 25_000 });
		const family = overlayField(stage.tv, 'fontFamily');
		let systemFamily: string | null = null;
		await expect
			.poll(
				async () => {
					systemFamily = await family();
					return systemFamily;
				},
				{ message: 'the reel reported no font family at the system default' }
			)
			.not.toBeNull();
		await putRoom(stage.phone, { lyricsFont: 'serif' });
		// RESOLVED FAMILIES, compared: `includes('serif')` is wrong, because a system-ui stack ends in
		// 'sans-serif' and would match.
		await expect
			.poll(family, { message: `lyrics-font=serif left the family at ${JSON.stringify(systemFamily)}` })
			.not.toBe(systemFamily);
		await putRoom(stage.phone, { lyricsFont: 'system' });
		await expect.poll(family, { message: 'lyrics-font=system did not restore the family' }).toBe(systemFamily);
	} finally {
		await stage.worker.stop();
	}
});

test('lyrics-case applies via text-transform live', async ({ world }) => {
	const stage = await lyricsStage(world);
	try {
		await expect(stage.tv.locator(SEL.lyricsRowCurrent)).toBeAttached({ timeout: 25_000 });
		const transform = overlayField(stage.tv, 'textTransform');
		await putRoom(stage.phone, { lyricsCase: 'upper' });
		await expect.poll(transform, { message: 'lyrics-case=upper did not reach the reel' }).toBe('uppercase');
		await putRoom(stage.phone, { lyricsCase: 'natural' });
		await expect.poll(transform, { message: 'lyrics-case=natural left the reel uppercased' }).not.toBe('uppercase');
	} finally {
		await stage.worker.stop();
	}
});

test('a sync-mode flip live-clamps the overlay without breaking it', async ({ world }) => {
	// sync-mode `lines` CLAMPS hl-word to hl-line and `forced` restores it, so the resolved values differ from
	// what was asked and the overlay must not break under the clamp.
	const stage = await lyricsStage(world);
	try {
		await expect(stage.tv.locator(SEL.lyrics)).toBeAttached({ timeout: 25_000 });
		const hl = overlayField(stage.tv, 'hlClass');
		await putGlobal(stage.phone, { syncMode: 'lines' });
		await expect.poll(hl, { message: 'syncMode=lines did not clamp the overlay to hl-line' }).toBe('hl-line');
		await putGlobal(stage.phone, { syncMode: 'forced' });
		await expect.poll(hl, { message: 'syncMode=forced did not restore hl-word' }).toBe('hl-word');
		// …and it survived: the reel is still the thing being asked.
		await expect(stage.tv.locator(SEL.lyrics)).toBeAttached();
	} finally {
		await stage.worker.stop();
	}
});

test('a media with an EMPTY lyrics artifact renders no broken reel', async ({ world }) => {
	const stage = await lyricsStage(world);
	try {
		await expect(stage.tv.locator(SEL.lyrics)).toBeAttached({ timeout: 25_000 });
		// There is no endpoint for clearing `lyricsRef`, so the ARTIFACT is replaced with content that parses to
		// null. `/media` answers `max-age=86400`, so without re-fulfilling it no-store the reload below would read
		// yesterday's copy and pass.
		await stage.tv.route('**/media/**', async (route) => {
			const response = await route.fetch();
			await route.fulfill({ response, headers: { ...response.headers(), 'cache-control': 'no-store' } });
		});
		writeFileSync(stage.lyricsPath, '{}');
		await stage.tv.reload();
		await stage.tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
		await stage.tv.mouse.click(960, 540);
		await expect(stage.tv.locator(SEL.mediaEl).first()).toBeAttached({ timeout: 25_000 });

		// The absent overlay and the inert one are BOTH correct, so the verdict is one boolean over one reading —
		// and the reading is carried alongside it so a failure says which half was wrong.
		let empty: { present: boolean; rows: number; hasCurrent: boolean; textLen: number } | null = null;
		await expect
			.poll(
				async () => {
					empty = await stage.tv.evaluate(
						({ lyrics, row, rowCurrent }) => {
							const l = document.querySelector(lyrics);
							return {
								present: !!l,
								rows: document.querySelectorAll(row).length,
								hasCurrent: document.querySelector(rowCurrent) !== null,
								textLen: (l?.textContent ?? '').trim().length
							};
						},
						{ lyrics: SEL.lyrics, row: SEL.lyricsRow, rowCurrent: SEL.lyricsRowCurrent }
					);
					return !empty.present || (!empty.hasCurrent && empty.textLen === 0);
				},
				{
					message:
						'an empty lyrics artifact left a reel on stage: the overlay should silently no-op, rendering ' +
						'either nothing at all or nothing with a current line and no text'
				}
			)
			.toBe(true);
	} finally {
		await stage.worker.stop();
	}
});
