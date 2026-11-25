// P16 — /queue's live controls, and their honest degradation. Two arms: WITH a guide mix, a live control; with NO
// isolated vocals, the control stays on screen disabled, dimmed on the control leaf rather than by an ancestor's
// opacity.
//
// Plus the gesture, the part no source scan can reach: a real tap on a Guide segment (Off / Low / Full, redesign
// step 5b) moves the guiding track.
//
// The controls are a card at the top of /queue, so "open" is a ROUTE rather than a height; there is no sheet,
// no snap array and no drag surface for a slider to fight.
//
// TWO AFFORDANCES ARE NOT TESTED ANYWHERE. Measured on /queue: `.more-slot a` resolves 0 — there is no
// "More about this song" door, so `/song/[mediaId]` is reachable only from a song row. And `.tools-note`
// resolves 0 — the sentence naming what still works for a song with no isolated vocals exists nowhere in the
// app, so the degraded arm below can only claim the control's own state, not the explanation beside it.
import { test, expect, type World } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker, type FakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue } from '../../world/actors';
import { serverPlayback } from './audio-probe-support';
import type { Page } from '@playwright/test';

/** The exact fragment of the sentence the deleted sheet derived for a song with no isolated vocals. Kept as a
 *  needle, not as a subject: it must appear on NEITHER arm now, and the arm that used to require it says so. */
const NOTE_FRAGMENT = 'no isolated vocals';

interface Profile {
	p05Midi?: number | null;
	p95Midi?: number | null;
}
interface Media {
	id: string;
	title: string;
	source?: string;
	stemStatus?: string;
	instrumentalRef?: string | null;
	vocalsRef?: string | null;
	guideMixRef?: string | null;
	songProfile?: Profile | null;
}
interface SearchBody {
	ready: Media[];
	processing: Media[];
	results: Media[];
}

// Computed here rather than importing `rangeLabel`: an oracle that calls the helper the UI calls would mirror a
// bug instead of catching one. The spelling is pinned in src/lib/contract/process/song-profile.ts, and a change
// to it should red here.
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(midi: number): string {
	const n = Math.round(midi);
	return `${SHARP_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}
function expectedRangeLabel(p: Profile | null | undefined): string | null {
	if (!p || typeof p.p05Midi !== 'number' || typeof p.p95Midi !== 'number') return null;
	return `${noteName(p.p05Midi)} - ${noteName(p.p95Midi)}`;
}

/**
 * The card's live-controls state, in ONE evaluate so every field describes the same paint — per-field round trips
 * can straddle a re-render and report a mix of two states.
 *
 * `rangeEl` is found by TEXT because the range block has no entry in the selector contract and inventing one here
 * would put a selector outside it. The walk is post-order so the DEEPEST match wins, and it matches on CONTAINS
 * rather than equality: the card prints the range in the key row's words as `· C3 - A4`.
 *
 * `guideDimmedByAncestor` is MEASURED rather than inferred from containment, which is the FRONTEND.md rule worth
 * measuring: dimming is a surface or ink change, never an opacity on a subtree holding text above the control.
 */
interface CardReading {
	cardPresent: boolean;
	cardOnScreen: boolean;
	guideCount: number;
	guidePresent: boolean;
	guidePainted: boolean;
	guideOnScreen: boolean;
	guideInCard: boolean;
	guideDisabled: boolean;
	guideChecked: string | null;
	guideDimmedByAncestor: string | null;
	keyCapCount: number;
	keyCapsLive: boolean;
	keyLabelText: string | null;
	rangeShown: boolean;
	rangeInKeyRow: boolean;
	pageTextHasFragment: boolean;
}

async function readCard(page: Page, expectedRange: string | null): Promise<CardReading> {
	return page.evaluate(
		({ S, RANGE_TEXT, FRAGMENT }) => {
			const q = (s: string) => document.querySelector(s);
			const qq = (s: string) => [...document.querySelectorAll(s)];
			const painted = (el: Element | null) => !!el && el.getClientRects().length > 0;
			const onScreen = (el: Element | null) => {
				if (!el) return false;
				const r = el.getBoundingClientRect();
				return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
			};

			const card = q(S.card);
			const guide = q(S.guide);
			const segs = guide ? ([...guide.querySelectorAll('[role="radio"]')] as HTMLButtonElement[]) : [];
			const keyLab = q(S.keyLab);
			const keyCaps = qq(S.keyCap) as HTMLButtonElement[];

			let rangeEl: Element | null = null;
			if (RANGE_TEXT && card) {
				const walk = (el: Element) => {
					for (let i = 0; i < el.children.length; i += 1) walk(el.children[i]);
					if (!rangeEl && (el.textContent ?? '').trim().includes(RANGE_TEXT)) rangeEl = el;
				};
				walk(card);
			}

			let dimAncestor: string | null = null;
			if (guide) {
				for (let el = guide.parentElement; el && el !== document.body; el = el.parentElement) {
					const op = parseFloat(getComputedStyle(el).opacity || '1');
					if (op < 1) {
						dimAncestor = `${el.tagName.toLowerCase()}.${String(el.className || '')} @ opacity ${op}`;
						break;
					}
				}
			}

			return {
				cardPresent: !!card,
				cardOnScreen: onScreen(card),
				guideCount: qq(S.guide).length,
				guidePresent: !!guide,
				guidePainted: painted(guide),
				guideOnScreen: onScreen(guide),
				guideInCard: !!(guide && card && card.contains(guide)),
				guideDisabled: segs.length > 0 && segs.every((b) => b.disabled),
				guideChecked: segs.find((b) => b.getAttribute('aria-checked') === 'true')?.textContent?.trim() ?? null,
				guideDimmedByAncestor: dimAncestor,
				keyCapCount: keyCaps.length,
				keyCapsLive:
					keyCaps.length > 0 && keyCaps.every((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true'),
				keyLabelText: keyLab?.textContent?.trim() ?? null,
				rangeShown: painted(rangeEl) && onScreen(rangeEl),
				// In the key row's words, under its label: the range transposes with the key the row sets.
				rangeInKeyRow: !!(rangeEl && keyLab?.closest(S.keyRow)?.contains(rangeEl)),
				pageTextHasFragment: (document.body.textContent ?? '').toLowerCase().includes(FRAGMENT)
			};
		},
		{
			// Every selector handed to the page ONCE — docs/E2E.md#why-selectors-are-centralised.
			S: {
				card: SEL.queueMyCard,
				guide: `${SEL.queueMyCard} ${SEL.guideSegments}`,
				keyCap: SEL.keyBtn,
				keyLab: SEL.keyLabel,
				keyRow: '.ctl'
			},
			RANGE_TEXT: expectedRange,
			FRAGMENT: NOTE_FRAGMENT
		}
	);
}

type ArmKind = 'withGuideMix' | 'noVocals';
/** One query per arm, so the two arms are two different songs even when both run against one core. */
const ARM_QUERY: Record<ArmKind, string> = { withGuideMix: 'caroline', noVocals: 'bohemian' };

interface Arm {
	phone: Page;
	song: Media;
	worker: FakeWorker;
	/** What the range block must read, computed independently of the helper the UI calls. */
	expectedRange: string;
}

/**
 * One arm's whole fixture: a worker configured for it, one song processed through the real job path, and a
 * joined phone with that song on stage.
 *
 * Every fixture invariant THROWS rather than failing a claim: the arms are meaningless if the two songs are not
 * actually in different states, and a fixture that silently drifted into one state would read as a clean pass.
 * `hasGuidingTrack` is `isPlayable(m) && !!m.guideMixRef` — the MIX, not the vocals stem — so the two are
 * checked separately: a song with vocals and no mix looks healthy while the enabled arm has no subject.
 */
async function setupArm(world: World, kind: ArmKind): Promise<Arm> {
	const query = ARM_QUERY[kind];
	const worker = await startFakeWorker(world, kind === 'withGuideMix' ? { guideMix: true } : { noVocals: true });
	// The dock and the card are thumb-zone chrome, so the 390px width is not incidental to the measurement.
	const phone = await world.openPhone('Probe');

	const search = async (): Promise<SearchBody> =>
		(await phone.request.get(`/api/search?q=${encodeURIComponent(query)}`).then((r) => r.json())) as SearchBody;
	const found = await search();
	const row = [...found.ready, ...found.processing, ...found.results].find((x) => x.source === 'local');
	if (!row) throw new Error(`no local library song matching "${query}" — the demo fixture did not index`);
	const res = await phone.request.post('/api/process', { data: { mediaId: row.id } });
	if (!res.ok()) throw new Error(`/api/process refused "${query}": ${res.status()} ${await res.text()}`);
	await expect
		.poll(async () => (await search()).ready.some((r) => r.id === row.id && !!r.instrumentalRef), {
			timeout: 60_000,
			message: `"${row.title}" never reached ready with an instrumental ref`
		})
		.toBe(true);

	const library = (await phone.request.get('/api/library').then((r) => r.json())) as { library: Media[] };
	const song = library.library.find((m) => m.id === row.id);
	if (!song) throw new Error(`"${row.title}" processed but is not in /api/library`);
	if (!song.vocalsRef && kind === 'withGuideMix') {
		throw new Error(`"${song.title}" processed with NO vocals ref; the with-stem arm has no subject`);
	}
	if (song.vocalsRef && kind === 'noVocals') {
		throw new Error(
			`noVocals did not withhold the vocals ref (got ${song.vocalsRef}); the degraded arm has no subject`
		);
	}
	if (!song.guideMixRef && kind === 'withGuideMix') {
		throw new Error(`"${song.title}" processed with NO guide mix ref; the ENABLED arm has no subject`);
	}
	if (song.guideMixRef && kind === 'noVocals') {
		throw new Error(`the degraded fixture got a guide mix (${song.guideMixRef}); its arm has no subject`);
	}
	// The fake worker publishes p05Midi/p95Midi unless `noProfile` is set, so a missing range is a fixture fault.
	const expectedRange = expectedRangeLabel(song.songProfile);
	if (!expectedRange) {
		throw new Error(
			`"${song.title}" reported no vocal range (songProfile=${JSON.stringify(song.songProfile ?? null)}), so the ` +
				`range claim has no subject`
		);
	}

	// Queued through the real row action, and the strip naming it is the room's own acknowledgement that it is on
	// stage: a ready song added to an idle room is promoted to `playing` by reconcileOnReady.
	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill(query);
	await phone.locator(SEL.addTurn).first().click();
	await expect(phone.locator(SEL.npStripTitle)).toContainText(song.title);

	return { phone, song, worker, expectedRange };
}

/**
 * Reach the controls. This replaces `raiseSheet`, and the difference is the whole point of the rebuild: there is
 * no transition to settle, so the old 400ms `VAUL_SETTLE_MS` dwell is gone and both waits below are CONDITIONS.
 * The card is waited for rather than assumed because `setupArm` has just proved a song is on stage, so its absence
 * here would be a real failure and not a legitimate idle state.
 */
async function openControls(phone: Page, expectedRange: string): Promise<CardReading> {
	await openQueue(phone);
	await phone.locator(SEL.queueMyCard).first().waitFor({ state: 'attached', timeout: 15_000 });
	await phone.locator(`${SEL.queueMyCard} ${SEL.guideSegments}`).waitFor({ state: 'attached', timeout: 15_000 });
	// The card is live once playback names the song: until then the guide reads the entry's preset.
	await expect(phone.locator(`${SEL.queueMyCard}.up`)).toBeAttached({ timeout: 15_000 });
	// Past the Spotlight's entrance fade, which is the card arriving, not a dimmed control.
	await phone
		.locator(SEL.queueMyCard)
		.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
	return readCard(phone, expectedRange);
}

test.describe('a song WITH a guide mix', () => {
	/**
	 * SIX readings off ONE snapshot of the card, deliberately not split: they describe one paint, and per-field
	 * round trips across a re-render report a mix of two states.
	 *
	 * THE DOOR HALF IS GONE. This test used to also assert the "More about this song" anchor pointed at
	 * `/song/${id}`; measured on /queue, `.more-slot a` resolves 0 — the door did not move with the rest of the
	 * sheet's body, so `/song/[mediaId]` is reachable from a song row and nowhere else.
	 */
	test('the now-playing card carries a live control, the key row and the range', async ({ world }) => {
		const arm = await setupArm(world, 'withGuideMix');
		try {
			const m = await openControls(arm.phone, arm.expectedRange);
			const detail = JSON.stringify(m);
			expect(m.cardPresent && m.cardOnScreen, `/queue rendered no now-playing card for a playing song\n${detail}`).toBe(
				true
			);
			// IN THE CARD, where the sheet version asserted "in the body and not on the drag handle". The surviving
			// half of that claim is the one that still binds: a control acting on the playing song must sit with the
			// playing song, not loose above the queued list.
			expect(m.guidePresent && m.guideInCard, `the control is not inside your card\n${detail}`).toBe(true);
			expect(m.guideCount, `the card stopped mounting its control at all\n${detail}`).toBe(1);
			expect(
				m.guidePresent && m.guidePainted && m.guideOnScreen && !m.guideDisabled,
				`a song WITH an isolated stem did not get a live control\n${detail}`
			).toBe(true);
			// Still asserted, though the sentence it needles exists on neither arm now: if an explanation were ever
			// re-added it must not be to the arm whose control works.
			expect(!m.pageTextHasFragment, `a working control came with an explanation it does not need\n${detail}`).toBe(
				true
			);
			// Read at keyShift 0, BEFORE the key row is driven: the range label transposes with the key.
			expect(
				m.rangeShown && m.rangeInKeyRow,
				`the vocal range is not in the key row's words: expected ${JSON.stringify(arm.expectedRange)} — ` +
					`shown=${m.rangeShown} inKeyRow=${m.rangeInKeyRow}`
			).toBe(true);
			expect(
				m.keyCapCount === 2 && m.keyCapsLive && m.keyLabelText === 'Key',
				`the key row is not present and live for a playable song: ${JSON.stringify({
					caps: m.keyCapCount,
					live: m.keyCapsLive,
					label: m.keyLabelText
				})}`
			).toBe(true);
		} finally {
			await arm.worker.stop();
		}
	});

	test('a keycap moves the key: the label follows the server broadcast', async ({ world }) => {
		const arm = await setupArm(world, 'withGuideMix');
		try {
			const before = (await openControls(arm.phone, arm.expectedRange)).keyLabelText;
			// Real input on the BUTTON, whose box is the keycap: p3-key-shift owns the pitch semantics, this arm
			// claims only the wiring.
			await arm.phone.locator(SEL.keyBtn).first().click();
			await expect
				.poll(async () => (await arm.phone.locator(SEL.keyLabel).first().textContent())?.trim() ?? null, {
					message: `the key label never left ${JSON.stringify(before)} after a keycap press`
				})
				.not.toBe(before);
		} finally {
			await arm.worker.stop();
		}
	});

	/**
	 * A TAP ON A SEGMENT MOVES THE GUIDING TRACK: the room's level becomes the segment's, and the segment the room
	 * answered with is the checked one. It taps the segment that is NOT checked, so it cannot pass on a level that
	 * never moved.
	 */
	test('a tap on a Guide segment moves the guiding track', async ({ world }) => {
		const arm = await setupArm(world, 'withGuideMix');
		try {
			const before = (await openControls(arm.phone, arm.expectedRange)).guideChecked;
			const target = before === 'Full' ? { name: 'Off', level: 0 } : { name: 'Full', level: 1 };
			await arm.phone
				.locator(`${SEL.queueMyCard} ${SEL.guideSegments}`)
				.getByRole('radio', { name: target.name })
				.click();
			await expect
				.poll(async () => (await serverPlayback(world.baseURL)).state.guideLevel ?? null, {
					message: `the room's guide never became ${target.name} after the tap (was ${before})`
				})
				.toBe(target.level);
			await expect(arm.phone.getByRole('radio', { name: target.name })).toHaveAttribute('aria-checked', 'true');
		} finally {
			await arm.worker.stop();
		}
	});
});

test.describe('a song with NO isolated vocals', () => {
	/**
	 * FOUR readings off ONE snapshot, for the same reason as the enabled arm.
	 *
	 * THE EXPLANATION HALF IS GONE, and this is the one place in the suite that records it. The sheet rendered a
	 * sentence naming what still works ("…no isolated vocals…") BEFORE the dead control, and asserted it was
	 * outside the dimmed subtree. Measured on /queue: `.tools-note` resolves 0 — nothing renders that sentence
	 * anywhere in the app, so the three claims about its text, its position and its containment have no subject.
	 * What survives is the control's own degradation, which is the FRONTEND.md rule worth measuring: dimmed on the
	 * control LEAF by ink, never by an ancestor's opacity over text.
	 */
	test('the control stays on screen disabled, dimmed on the leaf and not by an ancestor opacity', async ({ world }) => {
		const arm = await setupArm(world, 'noVocals');
		try {
			const m = await openControls(arm.phone, arm.expectedRange);
			const detail = JSON.stringify(m);
			expect(
				m.guidePresent && m.guidePainted && m.guideOnScreen && m.guideDisabled,
				`the control did not stay on screen, disabled, for a song with no stem\n${detail}`
			).toBe(true);
			// MEASURED: no ancestor of the control dims it, and the text around it, with opacity.
			expect(
				m.guideDimmedByAncestor === null,
				`an ancestor dims the control with opacity (measured): firstDimmedAncestor=${JSON.stringify(
					m.guideDimmedByAncestor
				)}`
			).toBe(true);
		} finally {
			await arm.worker.stop();
		}
	});
});
