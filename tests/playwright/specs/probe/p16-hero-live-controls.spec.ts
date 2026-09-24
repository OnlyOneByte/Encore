// P16 — the now-playing sheet's live controls, and their honest degradation. Two arms: WITH a guide mix, a live
// control and no explanation beside it; with NO isolated vocals, the control stays on screen disabled, its
// readout says 'Off', and a sentence naming what still works renders BEFORE it.
//
// Plus the gesture pair, the part no source scan can reach: a real pointer drag on the SLIDER moves the guiding
// track and does NOT put the sheet away, while a drag on the HANDLE does. THE MECHANISM IS `data-vaul-no-drag`
// — on `.np-fit` (the whole sheet body) and on `.tp` (the band's transport). Vaul's `handleOnly` is deliberately
// ABSENT because it is all-or-nothing and would turn the body's sliders into drag surfaces.
//
// THE SHEET IS MOUNTED AT ALL TIMES, which is the one thing that moved since the old probe: it asserted
// `sliderCount === 0` and `!drawerPresent` while shut, because that vaul build portalled the content on open and
// destroyed it on close. Today `.np-drawer` and everything in it resolve cold, so "away" is a HEIGHT — the sheet
// resting at snap 0 with its body below the fold — and "dismissed" is a return to that height. Same claims,
// measured on the mechanism that now expresses them; a presence check would pass vacuously forever.
//
// Ported from tests/e2e/probes/p16-hero-live-controls.mjs. Its filename kept `hero` to stay paired with a guard
// that no longer exists (the whole tests/guards/ tree is deleted), so the name follows the subject now.
import { test, expect, type World } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker, type FakeWorker } from '../../world/workers';
import { openBrowseFromHome, openNowPlaying } from '../../world/actors';
import { BAND_SNAP_PX } from '$lib/sheet-snap';
import type { Page } from '@playwright/test';

/** The exact fragment of the sentence the sheet derives for a song with no isolated vocals. */
const NOTE_FRAGMENT = 'no isolated vocals';
/** vaul animates the sheet between snap points; a geometry read taken mid-transition reads a frame that is
 *  still moving. This dwell is the transition settling, not a wait for data. */
const VAUL_SETTLE_MS = 400;
/** A dim ancestor is only believed once it survives this — vaul's own fade reports below full alpha. */
const OPACITY_RECHECK_MS = 800;

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
 * The sheet's live-controls state, in ONE evaluate so every field describes the same paint — per-field round
 * trips can straddle a re-render and report a mix of two states.
 *
 * `rangeEl` is found by TEXT because the range block has no entry in the selector contract and inventing one
 * here would put a selector outside it; the walk is post-order so the DEEPEST exact match wins (the label span,
 * not the section around it). `noteDimmedByAncestor` is MEASURED rather than inferred from containment, because
 * GuidingTrack's dimming sits on the control leaf.
 *
 * ON SCREEN is a separate field from PAINTED everywhere below: a collapsed sheet's body has boxes — so
 * `getClientRects()` is non-empty — and sits entirely under the fold.
 */
interface SheetReading {
	drawerPresent: boolean;
	drawerTop: number | null;
	viewportH: number;
	/** The live `--dock-h`, so nothing here can drift from the token the layout publishes. */
	dockH: number;
	/** The sheet is resting at snap 0 — its top edge is the band strip's height off the bottom. */
	atBandSnap: boolean;
	/** Pulled up: the same relation world/actors.ts uses, so the two cannot disagree. */
	raised: boolean;
	songText: string | null;
	bandOpenPresent: boolean;
	bodyPresent: boolean;
	bodyOnScreen: boolean;
	sliderCount: number;
	sliderPresent: boolean;
	sliderPainted: boolean;
	sliderOnScreen: boolean;
	sliderInBody: boolean;
	sliderOnDragHandle: boolean;
	dragHandlePresent: boolean;
	sliderDisabled: boolean;
	readout: string | null;
	notePresent: boolean;
	noteOnScreen: boolean;
	noteText: string | null;
	noteInsideDimmedSubtree: boolean;
	noteInBody: boolean;
	noteBeforeControl: boolean;
	noteDimmedByAncestor: string | null;
	gtDimmed: boolean;
	keyCapCount: number;
	keyCapsLive: boolean;
	keyLabelText: string | null;
	rangeShown: boolean;
	rangeBelowKeyRow: boolean;
	pageTextHasFragment: boolean;
	moreHref: string | null;
	moreLabel: string | null;
	moreIsAnchor: boolean;
}

async function readSheet(page: Page, expectedRange: string | null): Promise<SheetReading> {
	return page.evaluate(
		({ S, RANGE_TEXT, FRAGMENT, bandSnapPx }) => {
			const q = (s: string) => document.querySelector(s);
			const qq = (s: string) => [...document.querySelectorAll(s)];
			const painted = (el: Element | null) => !!el && el.getClientRects().length > 0;
			const onScreen = (el: Element | null) => {
				if (!el) return false;
				const r = el.getBoundingClientRect();
				return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
			};

			const drawer = q(S.drawer);
			const body = q(S.body);
			const note = q(S.note);
			const gt = q(S.gt);
			const slider = q(S.slider);
			const handle = q(S.drawerHandle);
			const keyLab = q(S.keyLab);
			const keyCaps = qq(S.keyCap) as HTMLButtonElement[];
			const dockH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-h')) || bandSnapPx;
			const drawerTop = drawer ? drawer.getBoundingClientRect().top : null;

			let rangeEl: Element | null = null;
			if (RANGE_TEXT && body) {
				const walk = (el: Element) => {
					for (let i = 0; i < el.children.length; i += 1) walk(el.children[i]);
					if (!rangeEl && (el.textContent ?? '').trim() === RANGE_TEXT) rangeEl = el;
				};
				walk(body);
			}

			let dimAncestor: string | null = null;
			if (note) {
				for (let el = note.parentElement; el && el !== document.body; el = el.parentElement) {
					const op = parseFloat(getComputedStyle(el).opacity || '1');
					if (op < 1) {
						dimAncestor = `${el.tagName.toLowerCase()}.${String(el.className || '')} @ opacity ${op}`;
						break;
					}
				}
			}

			return {
				drawerPresent: !!drawer,
				drawerTop,
				viewportH: innerHeight,
				dockH,
				// The strip is clipped to exactly BAND_SNAP_PX, so snap 0 puts the sheet's top that far off the
				// bottom. A whole pixel of tolerance, because a snap offset resolves through a transform.
				atBandSnap: drawerTop !== null && Math.abs(drawerTop - (innerHeight - bandSnapPx)) <= 1.5,
				raised: drawerTop !== null && drawerTop < innerHeight - dockH * 2,
				songText: q(S.song)?.textContent?.trim() ?? null,
				bandOpenPresent: !!q(S.bandOpen),
				bodyPresent: !!body,
				bodyOnScreen: onScreen(body),
				sliderCount: qq(S.slider).length,
				sliderPresent: !!slider,
				sliderPainted: painted(slider),
				sliderOnScreen: onScreen(slider),
				sliderInBody: !!(slider && body && body.contains(slider)),
				sliderOnDragHandle: !!(slider && handle && handle.contains(slider)),
				dragHandlePresent: !!handle,
				// PRESENCE, not value: Bits UI emits data-disabled="" when disabled and omits it when enabled.
				sliderDisabled:
					!!slider && (slider.hasAttribute('data-disabled') || slider.getAttribute('aria-disabled') === 'true'),
				readout: q(S.readout)?.textContent?.trim() ?? null,
				notePresent: !!note,
				noteOnScreen: onScreen(note),
				noteText: note?.textContent?.trim() ?? null,
				noteInsideDimmedSubtree: !!(gt && note && gt.contains(note)),
				noteInBody: !!(body && note && body.contains(note)),
				noteBeforeControl: !!(
					note &&
					slider &&
					(note.compareDocumentPosition(slider) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
				),
				noteDimmedByAncestor: dimAncestor,
				gtDimmed: !!gt && gt.classList.contains('disabled'),
				keyCapCount: keyCaps.length,
				keyCapsLive:
					keyCaps.length > 0 && keyCaps.every((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true'),
				keyLabelText: keyLab?.textContent?.trim() ?? null,
				rangeShown: painted(rangeEl) && onScreen(rangeEl),
				rangeBelowKeyRow: !!(
					keyLab &&
					rangeEl &&
					(keyLab.compareDocumentPosition(rangeEl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
				),
				pageTextHasFragment: (document.body.textContent ?? '').toLowerCase().includes(FRAGMENT),
				// The door to /song/[mediaId]. An ANCHOR, so back is the browser's own and the route is shareable.
				moreHref: (q(S.songDoor) as HTMLAnchorElement | null)?.getAttribute('href') ?? null,
				moreLabel: q(S.songDoor)?.getAttribute('aria-label') ?? null,
				moreIsAnchor: q(S.songDoor)?.tagName === 'A'
			};
		},
		{
			// Every selector handed to the page ONCE — docs/E2E.md#why-selectors-are-centralised.
			S: {
				drawer: SEL.npDrawer,
				song: SEL.bandTitle,
				drawerHandle: SEL.drawerHandle,
				body: SEL.toolsBody,
				note: SEL.toolsNote,
				gt: SEL.guidingTrackRoot,
				readout: SEL.guideReadout,
				slider: SEL.slider,
				keyCap: SEL.keyBtn,
				keyLab: SEL.keyLabel,
				bandOpen: SEL.bandOpen,
				songDoor: SEL.songDoor
			},
			RANGE_TEXT: expectedRange,
			FRAGMENT: NOTE_FRAGMENT,
			bandSnapPx: BAND_SNAP_PX
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
	// The drawer and the band are thumb-zone chrome, so the 390px width is not incidental to the measurement.
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

	// Queued through the real row action, and the band naming it is the room's own acknowledgement that it is on
	// stage: a ready song added to an idle room is promoted to `playing` by reconcileOnReady.
	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill(query);
	await phone.locator(SEL.addTurn).first().click();
	await expect(phone.locator(SEL.bandTitle)).toContainText(song.title);

	return { phone, song, worker, expectedRange };
}

/** Raise the sheet and let vaul's transition finish before anything is measured off it. */
async function raiseSheet(phone: Page, expectedRange: string): Promise<SheetReading> {
	await openNowPlaying(phone);
	await new Promise((r) => setTimeout(r, VAUL_SETTLE_MS));
	return readSheet(phone, expectedRange);
}

/**
 * A REAL stepped pointer drag: a handler reading pointer deltas needs real events, and a teleporting pointer
 * proves nothing about either the slider or the sheet.
 *
 * The per-step dwell is not decoration — vaul's drag is time-dependent (it derives a velocity and decides which
 * snap point to land on from it), so a whole gesture delivered inside one task is a gesture with no duration.
 * The old driver carried the same 20ms.
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
	test('the controls start away: the band offers its expand button and the body is below the fold', async ({
		world
	}) => {
		const arm = await setupArm(world, 'withGuideMix');
		try {
			// SHUT FIRST: the controls must not occupy the screen until asked for, while the band still says what
			// is playing.
			const m = await readSheet(arm.phone, arm.expectedRange);
			const detail = JSON.stringify(m);
			expect(m.bandOpenPresent, `the band offers no expand button — there is no way in\n${detail}`).toBe(true);
			expect(
				m.atBandSnap,
				`the sheet is not resting at snap 0 (top=${m.drawerTop}, viewport=${m.viewportH}, band=${BAND_SNAP_PX})\n${detail}`
			).toBe(true);
			expect(m.bodyOnScreen, `the live-controls body is on screen with the sheet away\n${detail}`).toBe(false);
			expect(
				typeof m.songText === 'string' && m.songText.includes(arm.song.title),
				`the band does not state what is playing while the controls are away: ${JSON.stringify(m.songText)}`
			).toBe(true);
			// The re-aimed form of the old `sliderCount === 0`: the sheet is permanently mounted, so the control
			// resolves — what must be true is that none of it is on screen.
			expect(m.sliderCount, `the sheet stopped mounting its control at all\n${detail}`).toBe(1);
			expect(m.sliderOnScreen, `the guiding-track control occupies the screen with the sheet away\n${detail}`).toBe(
				false
			);
			expect(m.noteOnScreen, `an explanation occupies the screen with the sheet away\n${detail}`).toBe(false);
		} finally {
			await arm.worker.stop();
		}
	});

	/**
	 * SEVEN readings off ONE snapshot of the raised sheet, deliberately not split: they describe one paint, and
	 * per-field round trips across a re-render report a mix of two states.
	 */
	test('the raised sheet carries a live control, the key row, the range and the door', async ({ world }) => {
		const arm = await setupArm(world, 'withGuideMix');
		try {
			const m = await raiseSheet(arm.phone, arm.expectedRange);
			const detail = JSON.stringify(m);
			expect(
				m.raised && m.bodyPresent && m.bodyOnScreen && m.dragHandlePresent,
				`the band's expand control did not bring the live-controls body on screen\n${detail}`
			).toBe(true);
			// The drag surface is the band row and the handle, so the control has to sit in the body that
			// `data-vaul-no-drag` excludes — a control on the handle would be a drag surface regardless.
			expect(
				m.sliderPresent && m.sliderInBody && !m.sliderOnDragHandle,
				`the control is not in the drawer BODY, or sits on the drag handle\n${detail}`
			).toBe(true);
			expect(
				m.sliderPresent && m.sliderPainted && m.sliderOnScreen && !m.sliderDisabled,
				`a song WITH an isolated stem did not get a live control\n${detail}`
			).toBe(true);
			expect(
				!m.notePresent && !m.pageTextHasFragment,
				`a working control came with an explanation it does not need\n${detail}`
			).toBe(true);
			// Read at keyShift 0, BEFORE the key row is driven: the range label transposes with the key.
			expect(
				m.rangeShown && m.rangeBelowKeyRow,
				`the vocal range is not in the same reveal as the key row: expected ${JSON.stringify(arm.expectedRange)} — ` +
					`shown=${m.rangeShown} belowKeyRow=${m.rangeBelowKeyRow}`
			).toBe(true);
			// Asserted against the id of the song actually playing, not merely for presence: a door pointing at the
			// wrong song is worse than no door.
			expect(
				m.moreIsAnchor && m.moreHref === `/song/${arm.song.id}`,
				`the "···" door is wrong: href=${JSON.stringify(m.moreHref)} (want "/song/${arm.song.id}"), tag ` +
					`${m.moreIsAnchor ? 'A' : 'not A'}, label=${JSON.stringify(m.moreLabel)}`
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
			const before = (await raiseSheet(arm.phone, arm.expectedRange)).keyLabelText;
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
	 * ONE GESTURE, TWO CLAIMS: the slider ANSWERS the drag (the sheet is not swallowing the pointer) and the
	 * sheet SURVIVES it (the body is excluded from dragging). It drags AWAY from the current level so the
	 * assertion cannot pass on a level that never moved, and carries a downward component because a real thumb
	 * drag is never perfectly horizontal — the vertical part is what a drag-anywhere sheet steals.
	 */
	test('a pointer drag on the slider moves the guiding track and does not put the sheet away', async ({ world }) => {
		const arm = await setupArm(world, 'withGuideMix');
		try {
			await raiseSheet(arm.phone, arm.expectedRange);
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

			const after = await readSheet(arm.phone, arm.expectedRange);
			expect(
				after.raised && after.sliderPresent && after.bodyPresent && after.bodyOnScreen,
				`the drag put the sheet away — the body is not excluded from dragging\n${JSON.stringify(after)}`
			).toBe(true);
		} finally {
			await arm.worker.stop();
		}
	});

	/**
	 * The other half: a sheet whose vendored Handle lost vaul's `data-slot` leaves the handle itself inert and
	 * nothing warns. "Dismissed" is a RETURN TO SNAP 0 — the sheet never closes — and the re-raise afterwards is
	 * the property the old probe got only as a side effect of its arm ordering.
	 */
	test('a pointer drag on the handle puts the sheet away, and it re-opens after', async ({ world }) => {
		const arm = await setupArm(world, 'withGuideMix');
		try {
			await raiseSheet(arm.phone, arm.expectedRange);
			const box = await arm.phone.locator(SEL.drawerHandle).boundingBox();
			if (!box)
				throw new Error("the sheet renders no vaul handle, so 'a drag on the handle puts it away' has no subject");
			const x = box.x + box.width / 2;
			const y = box.y + box.height / 2;
			await drag(arm.phone, { x, y }, { x, y: y + 420 }, 14);

			// The whole reading is polled rather than the one flag, so a failure prints where the sheet actually
			// came to rest instead of only that it was not at snap 0.
			await expect
				.poll(async () => await readSheet(arm.phone, arm.expectedRange), {
					message: 'the sheet was still up after a 420px downward drag on its handle'
				})
				.toMatchObject({ atBandSnap: true, raised: false });

			const reopened = await raiseSheet(arm.phone, arm.expectedRange);
			expect(
				reopened.raised && reopened.bodyOnScreen,
				`the sheet did not come back up after being put away\n${JSON.stringify(reopened)}`
			).toBe(true);
		} finally {
			await arm.worker.stop();
		}
	});
});

test.describe('a song with NO isolated vocals', () => {
	/**
	 * FIVE readings off ONE snapshot, for the same reason as the enabled arm, plus the opacity re-read: a dim
	 * ancestor is only believed once it has survived vaul's own fade.
	 */
	test('the control stays on screen disabled, and the reason renders before it, undimmed', async ({ world }) => {
		const arm = await setupArm(world, 'noVocals');
		try {
			const m = await raiseSheet(arm.phone, arm.expectedRange);
			const detail = JSON.stringify(m);
			expect(
				m.sliderPresent && m.sliderPainted && m.sliderOnScreen && m.sliderDisabled,
				`the control did not stay on screen, disabled, for a song with no stem\n${detail}`
			).toBe(true);
			expect(m.readout, `the readout shows a live-looking number rather than 'Off'`).toBe('Off');
			expect(
				m.notePresent && /still work/i.test(m.noteText ?? ''),
				`the reason is missing or does not name what still works: ${JSON.stringify(m.noteText)}`
			).toBe(true);
			// The reason must be read BEFORE the dead row, and must live with the controls, not in the header.
			expect(
				m.noteInBody && m.noteBeforeControl,
				`the reason does not render before the control it explains, inside the controls body: ${JSON.stringify({
					inBody: m.noteInBody,
					beforeControl: m.noteBeforeControl
				})}`
			).toBe(true);
			// `class:disabled` on `.gt` is the anchor the contract pins; the measured arm below is what still holds
			// now that the dimming sits on the control leaf.
			expect(
				m.gtDimmed && !m.noteInsideDimmedSubtree,
				`the reason is inside the subtree the disabled control marks: gtDimmed=${m.gtDimmed} ` +
					`inside=${m.noteInsideDimmedSubtree}`
			).toBe(true);

			let dimmedBy = m.noteDimmedByAncestor;
			if (dimmedBy !== null) {
				await new Promise((r) => setTimeout(r, OPACITY_RECHECK_MS));
				dimmedBy = (await readSheet(arm.phone, arm.expectedRange)).noteDimmedByAncestor;
			}
			expect(
				m.notePresent && dimmedBy === null,
				`an ancestor dims the reason with opacity (measured): firstDimmedAncestor=${JSON.stringify(dimmedBy)}`
			).toBe(true);
		} finally {
			await arm.worker.stop();
		}
	});
});
