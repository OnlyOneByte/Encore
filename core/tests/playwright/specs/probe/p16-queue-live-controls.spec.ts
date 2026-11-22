// P16 — /queue's live controls, and their honest degradation. Two arms: WITH a guide mix, a live control; with NO
// isolated vocals, the control stays on screen disabled and its readout says 'Off', dimmed on the control leaf
// rather than by an ancestor's opacity.
//
// Plus the gesture, the part no source scan can reach: a real pointer drag on the SLIDER moves the guiding track.
// That is the only coverage of /queue's throttle-and-trailing-send.
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

/** 'Off' is zero, not absent: the readout says it at level 0 and for a dead control alike. */
function pctOf(text: string | null): number | null {
	if (text === null) return null;
	if (text === 'Off') return 0;
	const m = /(\d+)/.exec(text);
	return m ? parseInt(m[1], 10) : null;
}

/**
 * The card's live-controls state, in ONE evaluate so every field describes the same paint — per-field round trips
 * can straddle a re-render and report a mix of two states.
 *
 * `rangeEl` is found by TEXT because the range block has no entry in the selector contract and inventing one here
 * would put a selector outside it. The walk is post-order so the DEEPEST match wins, and it matches on CONTAINS
 * rather than equality: /queue prints the range inside the facts line as `· C3 - A4`, where the sheet's own block
 * printed the label alone.
 *
 * `readoutDimmedByAncestor` is MEASURED rather than inferred from containment, which is the FRONTEND.md rule worth
 * measuring: dimming is a surface or ink change, never an opacity on a subtree holding text. GuidingTrack's own
 * comment says the same, and `.gt.disabled .gt-val { color: var(--ink-dim) }` is how it keeps the promise.
 */
interface CardReading {
	cardPresent: boolean;
	cardOnScreen: boolean;
	sliderCount: number;
	sliderPresent: boolean;
	sliderPainted: boolean;
	sliderOnScreen: boolean;
	sliderInCard: boolean;
	sliderDisabled: boolean;
	readout: string | null;
	readoutDimmedByAncestor: string | null;
	gtDimmed: boolean;
	keyCapCount: number;
	keyCapsLive: boolean;
	keyLabelText: string | null;
	rangeShown: boolean;
	rangeAboveKeyRow: boolean;
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
			const gt = q(S.gt);
			const slider = q(S.slider);
			const readoutEl = q(S.readout);
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
			if (readoutEl) {
				for (let el = readoutEl.parentElement; el && el !== document.body; el = el.parentElement) {
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
				sliderCount: qq(S.slider).length,
				sliderPresent: !!slider,
				sliderPainted: painted(slider),
				sliderOnScreen: onScreen(slider),
				sliderInCard: !!(slider && card && card.contains(slider)),
				// PRESENCE, not value: Bits UI emits data-disabled="" when disabled and omits it when enabled.
				sliderDisabled:
					!!slider && (slider.hasAttribute('data-disabled') || slider.getAttribute('aria-disabled') === 'true'),
				readout: readoutEl?.textContent?.trim() ?? null,
				readoutDimmedByAncestor: dimAncestor,
				gtDimmed: !!gt && gt.classList.contains('disabled'),
				keyCapCount: keyCaps.length,
				keyCapsLive:
					keyCaps.length > 0 && keyCaps.every((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true'),
				keyLabelText: keyLab?.textContent?.trim() ?? null,
				rangeShown: painted(rangeEl) && onScreen(rangeEl),
				// ABOVE, where the sheet put it below: /queue's card reads eyebrow, title, byline, clock, FACTS (key
				// and range), then the key row, then the guide and the bar. So the range is part of the song's
				// statement of fact rather than a consequence of the control under it.
				// `keyLab` is the RECEIVER and PRECEDING is the flag, which reads backwards and is deliberate: narrowing
				// `rangeEl` (assigned inside a closure) to a non-null receiver is something TypeScript will not do.
				rangeAboveKeyRow: !!(
					keyLab &&
					rangeEl &&
					(keyLab.compareDocumentPosition(rangeEl) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
				),
				pageTextHasFragment: (document.body.textContent ?? '').toLowerCase().includes(FRAGMENT)
			};
		},
		{
			// Every selector handed to the page ONCE — docs/E2E.md#why-selectors-are-centralised.
			S: {
				card: SEL.queueNowCard,
				gt: SEL.guidingTrackRoot,
				readout: SEL.guideReadout,
				slider: SEL.slider,
				keyCap: SEL.keyBtn,
				keyLab: SEL.keyLabel
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
	await phone.locator(SEL.queueNowCard).first().waitFor({ state: 'attached', timeout: 15_000 });
	await phone.locator(SEL.slider).first().waitFor({ state: 'attached', timeout: 15_000 });
	return readCard(phone, expectedRange);
}

/**
 * A REAL stepped pointer drag: a handler reading pointer deltas needs real events, and a teleporting pointer
 * proves nothing about the slider.
 *
 * THE PER-STEP DWELL SURVIVES THE SHEET, for a different reason. It used to be there because vaul's drag derived a
 * velocity and a whole gesture delivered inside one task has no duration. What it buys now is the subject of the
 * one test that uses it: /queue's guide handler throttles sends to 120ms and schedules a TRAILING one, so a
 * gesture with no duration never exercises either branch.
 */
const DRAG_STEP_MS = 20;
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps: number) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	for (let i = 1; i <= steps; i++) {
		await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
		await new Promise((r) => setTimeout(r, DRAG_STEP_MS));
	}
	await page.mouse.up();
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
			expect(m.sliderPresent && m.sliderInCard, `the control is not inside the now-playing card\n${detail}`).toBe(true);
			expect(m.sliderCount, `the card stopped mounting its control at all\n${detail}`).toBe(1);
			expect(
				m.sliderPresent && m.sliderPainted && m.sliderOnScreen && !m.sliderDisabled,
				`a song WITH an isolated stem did not get a live control\n${detail}`
			).toBe(true);
			// Still asserted, though the sentence it needles exists on neither arm now: if an explanation were ever
			// re-added it must not be to the arm whose control works.
			expect(!m.pageTextHasFragment, `a working control came with an explanation it does not need\n${detail}`).toBe(
				true
			);
			// Read at keyShift 0, BEFORE the key row is driven: the range label transposes with the key. ABOVE the key
			// row, which is the direction that changed with the move — see the note on `rangeAboveKeyRow`.
			expect(
				m.rangeShown && m.rangeAboveKeyRow,
				`the vocal range is not in the card's facts line above the key row: expected ${JSON.stringify(arm.expectedRange)} — ` +
					`shown=${m.rangeShown} aboveKeyRow=${m.rangeAboveKeyRow}`
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
	 * THE SLIDER ANSWERS A REAL DRAG. This used to be two claims in one gesture — the slider answers AND the sheet
	 * survives — and the second half died with the sheet: there is no drag surface under the control any more, so
	 * `data-vaul-no-drag` has nothing to exclude it from. The first half is worth more than the pair was: it is the
	 * only coverage of the throttle-and-trailing-send /queue inherited verbatim.
	 *
	 * It drags AWAY from the current level so the assertion cannot pass on a level that never moved, and carries a
	 * downward component because a real thumb drag is never perfectly horizontal.
	 */
	test('a pointer drag on the slider moves the guiding track', async ({ world }) => {
		const arm = await setupArm(world, 'withGuideMix');
		try {
			await openControls(arm.phone, arm.expectedRange);
			const box = await arm.phone.locator(SEL.slider).boundingBox();
			if (!box || box.width < 40) {
				throw new Error(`the guiding-track slider measured ${JSON.stringify(box)}; there is no track to drag along`);
			}
			const before = pctOf((await arm.phone.locator(SEL.guideReadout).first().textContent())?.trim() ?? null);
			if (before === null) throw new Error('the guiding-track readout is unreadable, so a level change cannot be seen');
			const low = before <= 50;
			const y = box.y + box.height / 2;
			await drag(
				arm.phone,
				{ x: box.x + box.width * (low ? 0.12 : 0.88), y },
				{ x: box.x + box.width * (low ? 0.85 : 0.15), y: y + 22 },
				10
			);

			await expect
				.poll(
					async () => {
						const after = pctOf((await arm.phone.locator(SEL.guideReadout).first().textContent())?.trim() ?? null);
						return after === null ? null : Math.abs(after - before);
					},
					{
						message:
							`the readout never left ${before}% across ${Math.round(box.width)}px of track — the drag did not ` +
							`reach the slider`
					}
				)
				.toBeGreaterThanOrEqual(10);
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
				m.sliderPresent && m.sliderPainted && m.sliderOnScreen && m.sliderDisabled,
				`the control did not stay on screen, disabled, for a song with no stem\n${detail}`
			).toBe(true);
			expect(m.readout, `the readout shows a live-looking number rather than 'Off'`).toBe('Off');
			// `class:disabled` on `.gt` is the anchor the contract pins; the measured arm below is what still holds
			// now that the dimming sits on the control leaf.
			expect(m.gtDimmed, `the disabled control does not mark itself: gtDimmed=${m.gtDimmed}\n${detail}`).toBe(true);
			// MEASURED, and read ONCE where the sheet version read twice: the second read existed to let vaul's own
			// fade finish, and there is no fade — /queue mounts the card with no transition at all.
			expect(
				m.readoutDimmedByAncestor === null,
				`an ancestor dims the readout with opacity (measured): firstDimmedAncestor=${JSON.stringify(
					m.readoutDimmedByAncestor
				)}`
			).toBe(true);
		} finally {
			await arm.worker.stop();
		}
	});
});
