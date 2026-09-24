// Rendered-DOM guards for the phone now-playing sheet and the queue rows around it. They MOUNT the
// components, because every claim is about what RENDERS. The mount-rung contract — the geometry refusal, the
// lent ResizeObserver, why `count()` rather than `toBeNull()` — is in docs/GUARDS.md#the-hygiene-and-meta-guards.
//
// The band and the drawer are ONE vaul drawer with snap points (SNAP_BAND = the band strip). So: there is no
// closed state (`open` defaults true and never changes); the whole body stays mounted at either height; it
// needs a `ResizeObserver` to render at all, because `.band-slot` carries `bind:clientHeight`; and it PORTALS,
// so every query runs against the one `[data-slot="drawer-content"]` element `openDrawer()` locates.
import { test, expect, afterEach } from 'bun:test';
import { read } from '@encore/test-support';
import { mount, unmount, flushSync } from '$setup/svelte-client';
import QueueRow from '$lib/components/QueueRow.svelte';
import NowPlayingDrawerHarness from './phone-home.harness.svelte';
import { waitShort } from '$lib/phrasing/position-sentence';
import { SNAP_BAND as SHEET_SNAP_BAND } from '$lib/sheet-snap';
import type { SongProfile } from '$lib/contract';

let live: Array<{ comp: unknown; host: HTMLElement }> = [];
afterEach(() => {
	// One lend around the whole loop: `withResizeObserver` refuses to nest, and tearing a drawer down re-runs
	// the same binding cleanups the mount armed.
	withResizeObserver(() => {
		for (const { comp, host } of live) {
			// `void` because a floating promise is a lint error; wrapped because teardown re-runs the measuring
			// effects, and the portal is removed either way.
			swallowGeometryRefusal(() => void unmount(comp as never));
			host.remove();
		}
	});
	live = [];
});

function render<P extends Record<string, unknown>>(Comp: unknown, props: P): HTMLElement {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const comp = mount(Comp as never, { target: host, props });
	flushSync();
	live.push({ comp, host });
	return host;
}

const GEOMETRY_REFUSAL = /^(\S+?)(?:\(\))? cannot measure on the MOUNT rung/;

/**
 * Every geometry API refused while this file ran, in first-seen order, so the LAST test can bound the set: a new
 * measuring dependency inside the drawer would otherwise be absorbed by the same catch. The rung's OTHER refusal
 * shape — an API it declines to INSTALL — is deliberately NOT matched: swallowing the bare ReferenceError would
 * leave every assertion querying an empty document, so it is LENT instead.
 */
const refusedApis: string[] = [];

function swallowGeometryRefusal(fn: () => void): void {
	try {
		fn();
	} catch (err) {
		const message = String((err as Error)?.message ?? err);
		const hit = GEOMETRY_REFUSAL.exec(message);
		if (!hit) throw err;
		if (!refusedApis.includes(hit[1]!)) refusedApis.push(hit[1]!);
	}
}

/**
 * Lend the ONE notification API this drawer needs in order to render; see
 * docs/GUARDS.md#the-rungs-and-what-each-can-honestly-decide for why lending fabricates nothing. It cannot be
 * SWALLOWED like `offsetWidth`: Svelte builds the observer inside a RENDER effect, so the ReferenceError
 * aborts the flush before bits-ui's portal effect runs and `Drawer.Content` never reaches the document.
 */
function withResizeObserver<T>(fn: () => T): T {
	const g = globalThis as Record<string, unknown>;
	expect(g.ResizeObserver, 'a ResizeObserver leaked into the global scope — see mount-rung.test.ts').toBeUndefined();
	g.ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	};
	try {
		return fn();
	} finally {
		delete g.ResizeObserver;
	}
}

/*
 * vaul identifies a snap point by VALUE, not index, and every arm here asserts the mounted DOM does not vary with
 * the snap point AT ALL — so `at` only has to be a plausible value, and an arm that depended on the number belongs
 * on the layout rung. SNAP_BAND is IMPORTED rather than restated: vaul looks the active point up by strict string
 * equality, so a stale local copy seats index -1, silently. SNAP_OPEN is the clamp's ceiling.
 */
const SNAP_BAND = SHEET_SNAP_BAND;
const SNAP_OPEN = 0.82;

/**
 * Mount the drawer through its harness and return the ONE portalled content element. Mounting IS opening, and
 * `at` places the sheet at a HEIGHT. Non-vacuous by construction: exactly one `[data-slot="drawer-content"]`
 * must be in the document, so a drawer that rendered nothing (or a leaked portal) fails here rather than
 * letting every `querySelector` below return null and pass.
 */
function openDrawer(props: Record<string, unknown> = {}, at: number | string = SNAP_OPEN): HTMLElement {
	const host = document.createElement('div');
	document.body.appendChild(host);
	withResizeObserver(() => {
		const comp = mount(NowPlayingDrawerHarness as never, { target: host, props: { activeSnapPoint: at, ...props } });
		live.push({ comp, host });
		swallowGeometryRefusal(() => flushSync());
	});
	const found = document.querySelectorAll('[data-slot="drawer-content"]');
	expect(found.length, 'expected exactly one drawer in the document').toBe(1);
	return found[0] as HTMLElement;
}

/** Tear the most recent drawer down; the next `openDrawer`'s exactly-one assertion proves it went away. */
function dropDrawer(): void {
	withResizeObserver(() => swallowGeometryRefusal(() => void unmount(live.pop()!.comp as never)));
}

/**
 * How many elements match. NOT `expect(root.querySelector(sel)).toBeNull()` — see
 * docs/GUARDS.md#accidental-green-and-its-mirror. Deliberately not applied to the smaller QueueRow trees.
 */
function count(root: ParentNode, selector: string): number {
	return root.querySelectorAll(selector).length;
}

/*
 * The playing fixture. There is no `byline` prop — the drawer derives it from `artist` plus the song's own
 * detected key — and `hint`/`controlsSummary`/`controlsNote` are gone for the same reason: the drawer owns
 * that copy.
 */
const PROFILE: SongProfile = {
	keyTonic: 7, // G
	keyMode: 'major',
	keyConfidence: 0.82,
	lowMidi: 48, // C3
	highMidi: 72, // C5
	p05Midi: 55, // G3
	p95Midi: 67, // G4
	histogram: null,
	loudnessLufs: -11.2
};

const PLAYING = {
	title: 'Bohemian Rhapsody',
	artist: 'Queen Official',
	singerName: 'Maya',
	singerColor: '#33d6a6',
	profile: PROFILE,
	keyShiftEnabled: true,
	guideEnabled: true,
	guideServerPct: 20,
	elapsedSec: 30,
	durationSec: 120,
	isPlaying: true,
	hasSong: true
};

const IDLE = { hasSong: false, title: null, artist: null, singerName: null };

test('the drawer names the song ONCE, in the band row, and names itself by label', () => {
	const content = openDrawer(PLAYING);
	// The COUNT is the claim, not "the song is named": the head once carried three second copies of the band row
	// stacked 40px below it, and a screen reader reads the whole tree even when nothing on screen shows it twice.
	expect(content.textContent).toContain('Bohemian Rhapsody');
	const titles = [...content.querySelectorAll('.band .title')];
	expect(titles.length, 'the band row must name the song exactly once').toBe(1);
	expect(titles[0].textContent).toBe('Bohemian Rhapsody');
	const occurrences = (content.textContent ?? '').split('Bohemian Rhapsody').length - 1;
	expect(occurrences, 'the song title must appear once in the whole dialog').toBe(1);
	expect(content.textContent).toContain('Maya is singing');
	expect(content.textContent).not.toContain('Now singing');

	// NAMED BY `aria-label` at every state: bits-ui sets `aria-labelledby` only once a `Drawer.Title` registers
	// an id, so with no Title the label wins the cascade. Both halves, since the failure mode is no name at all.
	expect(content.getAttribute('aria-labelledby'), 'no Title should register an id now').toBeNull();
	expect(content.getAttribute('aria-label')).toBe('Now playing');

	expect(count(content, '.seq')).toBe(0);
	expect(count(content, '.qrow')).toBe(0);
	expect(content.classList.contains('np-drawer')).toBe(true);
	expect(content.getAttribute('role')).toBe('dialog');
});

test('the drawer carries the singer identity colour on a dot that cannot collapse', () => {
	const content = openDrawer(PLAYING);
	// app.css's shared `.singer-dot` is where `flex: 0 0 auto` — the "cannot collapse" half — lives. Exactly one dot:
	// the head's eyebrow stated the singer a second way under the byline, and the colour arrives as the custom
	// property the rule reads so a long name cannot silently drop it.
	const dot = content.querySelector('.band .byline .dot') as HTMLElement | null;
	expect(count(content, '.band .byline .dot')).toBe(1);
	expect(count(content, '.eyebrow'), 'the head must not state the singer a second way').toBe(0);
	expect(dot!.getAttribute('style')).toContain('#33d6a6');
});

test('an unknown song length hides the progress row rather than pinning a bar at zero', () => {
	const unknown = openDrawer({ ...PLAYING, durationSec: 0 });
	expect(count(unknown, '.seekrow')).toBe(0);
	expect(count(unknown, '[role="progressbar"]')).toBe(0);

	dropDrawer();
	const known = openDrawer(PLAYING);
	expect(count(known, '[role="progressbar"]')).toBe(1);
	const bar = known.querySelector('[role="progressbar"]') as HTMLElement;
	// 30s of 120s is a quarter, written out rather than computed: the operation the component performs cannot be the
	// source of the expectation. A transform, not width: a width animation triggers layout every frame.
	expect(bar.getAttribute('aria-valuenow')).toBe('25');
	expect(count(bar, '[data-slot="progress-indicator"]')).toBe(1);
	const fill = bar.querySelector('[data-slot="progress-indicator"]') as HTMLElement;
	expect(fill.getAttribute('style')).toContain('translateX(-75%)');
	expect(fill.getAttribute('style')).not.toContain('width:');
});

test('the transport is disabled when there is nothing for it to act on', () => {
	const btn = (root: HTMLElement, label: string) =>
		root.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
	// The disc is addressed by CLASS because its accessible name alternates (Play/Pause). `canStart` lives on
	// the disc and nothing else — the "a queue exists but nothing is current" case a rearrangement drops.
	const disc = (root: HTMLElement) => root.querySelector('.disc') as HTMLButtonElement;
	// No second play/pause anywhere. The COUNT is the assertion rather than the absence of a particular label:
	// two earlier arrangements shipped a duplicate, under two different labels.
	const plays = (root: HTMLElement) => root.querySelectorAll('button[aria-label="Play"], button[aria-label="Pause"]');

	const empty = openDrawer(IDLE);
	expect(btn(empty, 'Restart').disabled).toBe(true);
	expect(btn(empty, 'skip').disabled).toBe(true);
	expect(disc(empty).disabled).toBe(true);
	expect(plays(empty).length, 'the app must carry exactly one play/pause').toBe(1);

	dropDrawer();
	const waiting = openDrawer({ ...IDLE, canStart: true });
	expect(disc(waiting).disabled).toBe(false);
	expect(btn(waiting, 'skip').disabled).toBe(true);

	dropDrawer();
	const playing = openDrawer(PLAYING);
	expect(btn(playing, 'Restart').disabled).toBe(false);
	expect(btn(playing, 'skip').disabled).toBe(false);
	expect(disc(playing).disabled).toBe(false);
	expect(plays(playing).length).toBe(1);
	expect(disc(playing).getAttribute('aria-label')).toBe('Pause');
});

// The drawer has NO DISCLOSURE: its live controls sit directly in the body and the range visualizer directly
// below the key row. The degradation arms needing a real layout engine stay in
// tests/e2e/probes/p16-hero-live-controls.mjs.
test('no disclosure stands between the singer and the live controls', () => {
	const content = openDrawer(PLAYING);
	expect(count(content, '.tools-body'), 'the live controls did not render for a playing song').toBe(1);
	const body = content.querySelector('.tools-body') as HTMLElement;
	expect(count(body, '.gt'), 'no guiding track').toBe(1);
	expect(count(body, '.key'), 'no key row').toBe(1);
	expect(count(body, '.rangebar'), 'no range visualizer').toBe(1);
	for (const banned of [
		'.tools',
		'details',
		'summary',
		'[data-slot^="collapsible"]',
		'[data-collapsible-trigger]',
		'[data-collapsible-content]'
	]) {
		expect(count(content, banned), `a disclosure came back as ${banned}`).toBe(0);
	}
	expect(String((content.querySelector('.key') as HTMLElement).nextElementSibling?.className)).toContain('range');
});

test('an idle room offers no "adjust while you sing" — there is nothing to adjust', () => {
	// Found in a driven idle frame: the disclosure rendered over an empty stage. These are LIVE controls for
	// the playing song, so `hasSong` gates them.
	const idle = openDrawer(IDLE);
	expect(count(idle, '.tools-body')).toBe(0);
	expect(count(idle, '.gt')).toBe(0);
	expect(idle.textContent).not.toContain('Adjust while you sing');
});

test('an idle drawer says "Nothing playing" exactly once', () => {
	const idle = openDrawer(IDLE);
	expect(count(idle, '.eyebrow')).toBe(0);
	// The second copy was a real source defect this rung caught: the head is past the fold at the collapsed snap point,
	// so nothing showed it twice, but a screen reader reads the whole dialog. The component was fixed rather than the
	// count relaxed — the head renders a title only when there IS a song.
	expect((idle.textContent ?? '').match(/Nothing playing/g)?.length).toBe(1);
	expect(idle.querySelector('.band-slot .band .title')?.textContent).toBe('Nothing playing');
	expect(count(idle, '[data-slot="drawer-title"]')).toBe(0);
	expect(idle.getAttribute('aria-labelledby')).toBeNull();
	expect(idle.getAttribute('aria-label')).toBe('Now playing');
	// AND SAYS NOTHING ELSE: the arm asserts the DECISION rather than a string — with nothing playing the
	// drawer renders NO second line at all, so there is nowhere for filler to come back.
	expect(count(idle, '[data-slot="drawer-description"]')).toBe(0);
	expect(idle.textContent).not.toContain('start the party');
});

/*
 * "The controls are not reachable while collapsed" has no mount-rung expression: what hides them is a
 * transform offset, a LAYOUT claim in tests/e2e/probes/. What is asserted instead is the structural fact the
 * mechanism rests on — the band row is COMPOSED as the sheet's first child and the body below it stays mounted
 * at either snap point, which is why the sheet can be dragged between two heights (an outside element cannot
 * hand vaul an in-flight pointer) and why the head may not restate the band row.
 */
test('the band row is the sheet itself, and the body stays mounted at the collapsed snap point', () => {
	const collapsed = openDrawer(PLAYING, SNAP_BAND);
	expect(count(collapsed, '.band-slot')).toBe(1);
	expect(count(collapsed, '.band-slot .band')).toBe(1);
	// FIRST, asserted as a POSITION rather than as mere presence: vaul sizes the content to the largest snap
	// point and translates it DOWN, so what shows at snap 0 is the TOP of the content. Anything inserted above
	// the band row silently becomes the collapsed face instead.
	const above = [...collapsed.children].slice(
		0,
		[...collapsed.children].indexOf(collapsed.querySelector('.band-slot')!)
	);
	// NOTHING may sit above the band row — a card, an alert or a second row landing there reds. The vendored
	// `drawer-content.svelte` used to render its own grab bar there, stacking two visible lines.
	expect(above.map((el) => el.getAttribute('data-slot') ?? el.tagName)).toEqual([]);
	expect(collapsed.querySelectorAll('[data-slot="drawer-handle"]').length).toBe(1);
	const head = collapsed.querySelector('[data-slot="drawer-header"]') as HTMLElement | null;
	expect(head, 'the drawer head did not render').not.toBeNull();
	expect(
		collapsed.querySelector('.band-slot')!.compareDocumentPosition(head!) & Node.DOCUMENT_POSITION_FOLLOWING
	).toBeTruthy();
	expect(count(collapsed, '.tools-body')).toBe(1);
	// ONE PLAY/PAUSE IN THE WHOLE TREE, counted rather than named: this row has held three arrangements and two shipped
	// a second play/pause under two different labels. Restart and skip are in the tree at BOTH heights, hidden at the
	// collapsed one by CSS rather than by a branch, which is what keeps the census arm below true.
	expect(
		collapsed.querySelectorAll('button[aria-label="Play"], button[aria-label="Pause"]').length,
		'expected exactly one play/pause in the app'
	).toBe(1);
	expect(count(collapsed, '.disc')).toBe(1);
	expect(count(collapsed, '.tp .btn')).toBe(2);
	expect(count(collapsed, '.transport'), 'the body transport row is gone — the pair is in the band row').toBe(0);

	// SAME TREE AT EITHER HEIGHT, asserted rather than assumed: it frees every other arm here to mount at one
	// snap point and say nothing about the other. Compared as an element COUNT plus rendered text, never
	// `innerHTML` — bits-ui and vaul mint per-instance ids, so two mounts never produce equal markup.
	const census = (el: HTMLElement) => ({ elements: el.querySelectorAll('*').length, text: el.textContent });
	const atBand = census(collapsed);
	expect(atBand.elements, 'the collapsed sheet rendered almost nothing').toBeGreaterThan(50);
	dropDrawer();
	expect(census(openDrawer(PLAYING, SNAP_OPEN))).toEqual(atBand);
});

test('the drawer NAMES the lyrics source and does not re-pick it', () => {
	// `/song/[mediaId]` already renders `LyricsReselect` and the `···` on the seek row is the door to it, so the
	// sheet's copy was the second one. BOTH halves — provenance STATED and control ABSENT — because either alone
	// would pass a sheet that lost the information along with the disclosure.
	const content = openDrawer({
		...PLAYING,
		candidates: [
			{ ref: 'a', textSource: 'lrclib', timing: 'word', textConfidence: 'high' },
			{ ref: 'b', textSource: 'asr', timing: 'line', textConfidence: 'low' }
		],
		chosenRef: 'a'
	});
	const body = content.querySelector('.tools-body') as HTMLElement | null;
	expect(count(content, '.tools-body')).toBe(1);
	expect(count(body!, '.reselect'), 'the sheet must not carry the re-selection control').toBe(0);
	expect(count(body!, '.lyricsrc .encore-chip'), 'the lyrics source pill did not render').toBe(1);
	expect(body!.querySelector('.lyricsrc')?.textContent?.trim()).toBe('Synced lyrics');

	// The override wins over the auto pick. The tone follows `isAuthoritativeText`: an auto-transcribed guess is
	// what a singer should know about before trusting the screen, so it is not painted like authored words.
	dropDrawer();
	const overridden = openDrawer({
		...PLAYING,
		candidates: [
			{ ref: 'a', textSource: 'lrclib', timing: 'word', textConfidence: 'high' },
			{ ref: 'b', textSource: 'asr', timing: 'line', textConfidence: 'low' }
		],
		chosenRef: 'a',
		overrideRef: 'b'
	});
	const pill = overridden.querySelector('.lyricsrc .encore-chip') as HTMLElement | null;
	expect(pill?.textContent?.trim()).toBe('Auto-transcribed');
	expect(pill?.className).toContain('encore-chip-warn');
	expect(
		(overridden.querySelector('.lyricsrc .encore-chip') as HTMLElement).className,
		'an auto-transcribed guess must not wear the authored-words tone'
	).not.toContain('encore-chip-ok');

	dropDrawer();
	expect(count(openDrawer(IDLE), '.lyricsrc')).toBe(0);
	dropDrawer();
	expect(
		count(openDrawer({ ...PLAYING, candidates: [], chosenRef: 'a' }), '.lyricsrc'),
		'no candidates means nothing honest to name'
	).toBe(0);
});

// The wait is a clause on the queue row's byline, built by `waitShort` from the same sum the deleted
// `MyPositionCard` used. What survives that card is the honest degradation, at the same strength.
test('a known wait renders as a byline clause after the up-next badge', () => {
	const host = render(QueueRow, {
		...ROW,
		singerName: 'You',
		mine: true,
		up: true,
		subtitle: `up next · ${waitShort(120, [200, 341])}`
	});
	const byline = host.querySelector('.who')?.textContent ?? '';
	expect(byline).toContain('up next');
	expect(byline).toContain('~11 min');
	expect(byline).not.toContain('· ·');
});

test('an unknown wait renders NO clause — not a zero, not a guess', () => {
	// One entry ahead with no resolvable length makes the whole sum unknown, so the formatter returns null, and
	// the row renders the badge alone with nothing where the clause would have been.
	expect(waitShort(120, [200, null])).toBeNull();
	const host = render(QueueRow, { ...ROW, singerName: 'You', mine: true, up: true, subtitle: 'up next' });
	const byline = host.querySelector('.who')?.textContent ?? '';
	expect(byline).toContain('up next');
	expect(byline.toLowerCase()).not.toContain('min');
	expect(byline).not.toContain('NaN');
	expect(byline).not.toContain('null');
});

// The fixture passes no `reorderable`/`canUp`/`canDown`: the arrow pair is retired, whether a row CAN move is
// `grip` and whether it MAY move right now is `pending`. Props a component no longer declares are how a
// fixture comes to describe a row that cannot exist.
const ROW = {
	seq: 3,
	title: 'Wonderwall',
	singerName: 'You',
	singerColor: '#5cb8ff',
	mine: true,
	removable: true,
	/*
	 * The grip publishes `data-grip={gripId}` and Svelte omits an attribute whose value is undefined, so a
	 * fixture without an id renders a grip no `[data-grip]` query can find.
	 */
	gripId: 'entry-1'
};

test('a pending REORDER says "moving…", never "adding…"', () => {
	const moving = render(QueueRow, { ...ROW, pending: 'move' });
	expect(moving.textContent).toContain('moving…');
	expect(moving.textContent).not.toContain('adding…');

	const adding = render(QueueRow, { ...ROW, pending: 'add' });
	expect(adding.textContent).toContain('adding…');
	expect(adding.textContent).not.toContain('moving…');

	const settled = render(QueueRow, { ...ROW, pending: null });
	expect(settled.querySelector('.adding')).toBeNull();
});

test('a row awaiting confirmation makes its own reorder controls inert', () => {
	// A second reorder of a move that has not landed would issue an op against a position the server has not
	// agreed to yet. The subject is the GRIP: it leads the row from its media slot, OUTSIDE the row's
	// `{#if !pending}` gate, so it carries its own `{#if grip && !pending}`.
	const moving = render(QueueRow, { ...ROW, grip: true, pending: 'move' });
	expect(moving.querySelector('[data-grip]')).toBeNull();
	expect(moving.querySelector('button[aria-label="remove from queue"]')).toBeNull();

	const settled = render(QueueRow, { ...ROW, grip: true, pending: null });
	expect(settled.querySelector('[data-grip]')).not.toBeNull();
	expect(settled.querySelector('button[aria-label="move up"]')).toBeNull();
	expect(settled.querySelector('button[aria-label="move down"]')).toBeNull();
});

test('the pending state is signalled on the row SURFACE, not by dimming its subtree', () => {
	const moving = render(QueueRow, { ...ROW, pending: 'move' });
	const root = moving.querySelector('.qrow') as HTMLElement;
	expect(root.className).toContain('pending');
	// happy-dom applies no stylesheet, so what bites here is an INLINE opacity on the rendered subtree; the
	// stylesheet half is contrast.test.ts's "no card root dims its own subtree with opacity".
	expect(root.getAttribute('style') ?? '').not.toContain('opacity');
});

test('the gallery carries the drawer and BOTH position branches, adjacent', () => {
	// A fixture's absence is invisible to every runtime assertion in the suite, which is how two earlier
	// `pending` rules shipped unreadable. The PAIR is the point for the wait: "no minutes clause" is only
	// judgeable against the clause it replaces.
	const gallery = read('src/routes/components/+page.svelte');
	expect(gallery).toContain('<NowPlayingDrawer');
	expect(gallery).not.toContain('<MyPositionCard');
	expect(gallery).toMatch(/import NowPlayingDrawer from '\$lib\/components\/NowPlayingDrawer\.svelte';/);
	expect(gallery).toMatch(/drawerHasSong = false;/);
	expect(gallery).toMatch(/hasSong=\{drawerHasSong\}/);

	const rows = [...gallery.matchAll(/<QueueRow[\s\S]*?\/>/g)].map((m) => m[0]);
	expect(rows.some((r) => /subtitle="[^"]*~\d+ min"/.test(r))).toBe(true);
	expect(rows.some((r) => /subtitle="[^"]*<1 min"/.test(r))).toBe(true);
	expect(rows.some((r) => /subtitle=""/.test(r))).toBe(true);
});

test('nothing beyond the KNOWN incidental geometry reads was swallowed', () => {
	/*
	 * The swallow would absorb a NEW measuring dependency, and a component that starts measuring its own layout
	 * belongs on the layout rung, so the refused names are BOUNDED. Each known entry is a read on a path this
	 * file asserts nothing about: `offsetWidth` (the Bits UI Slider), `clientHeight` (`bind:clientHeight` on
	 * `.band-slot` — the proof that lending a ResizeObserver fabricates nothing, since the MEASUREMENT still
	 * refuses by name), and `clientWidth` (bits-ui's scrollbar compensation, which only fires for a MODAL dialog,
	 * so whether it appears depends on suite order — hence a SUBSET check plus two required members).
	 *
	 * If this reds with an unlisted name, decide whether the claim that depends on it moves to
	 * tests/e2e/probes/ — do not add the name reflexively.
	 */
	const known = ['clientWidth', 'offsetWidth', 'clientHeight'];
	expect(refusedApis.filter((api) => !known.includes(api))).toEqual([]);
	expect(refusedApis).toContain('offsetWidth');
	expect(refusedApis).toContain('clientHeight');
});
