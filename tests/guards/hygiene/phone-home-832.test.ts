// Rendered-DOM guards for the phone home screen direction A builds.
//
// These MOUNT the two new components under the repo's happy-dom + compiled-Svelte harness
// (tests/setup/, wired by the root bunfig.toml) rather than scanning their source, because every claim
// below is about what RENDERS: whether the wait clause is on screen, whether the progress row exists,
// whether a range input ended up in a disclosure summary. XR-PH-21 is explicit that a measurement
// claim cannot be satisfied by a source scan, and this repo's own record is that the defects that
// shipped were invisible to a passing suite.
//
// Both components are import-clean (no `$app`, no `$env`, no store), which is what makes them
// mountable at all — the harness aliases neither virtual module today.
import { test, expect, afterEach } from 'bun:test';
import { read } from '@encore/test-support';
import { mount, unmount, flushSync } from '../../../tests/setup/svelte-client';
import NowPlayingHero from '$lib/components/NowPlayingHero.svelte';
import MyPositionCard from '$lib/components/MyPositionCard.svelte';
import QueueRow from '$lib/components/QueueRow.svelte';
import HeroWithControls from './phone-home-832.harness.svelte';
import { positionWords } from '$lib/position-sentence';

let live: Array<{ comp: unknown; host: HTMLElement }> = [];
afterEach(() => {
	for (const { comp, host } of live) {
		// `void`: unmount returns a promise (it can await outro transitions) and nothing here has any, so
		// the teardown is synchronous in practice — but a floating promise is a lint error either way.
		void unmount(comp as never);
		host.remove();
	}
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

const PLAYING = {
	title: 'Bohemian Rhapsody',
	singerName: 'Maya',
	singerColor: '#33d6a6',
	byline: 'Queen Official · G major',
	elapsedSec: 30,
	durationSec: 120,
	isPlaying: true,
	hasSong: true
};

// ── the hero is a hero, not a row ────────────────────────────────────────────────────────────────
test('the hero renders the playing song as a heading, with the singer named', () => {
	const host = render(NowPlayingHero, PLAYING);
	const h1 = host.querySelector('h1');
	expect(h1?.textContent).toBe('Bohemian Rhapsody');
	expect(host.textContent).toContain('Now singing · Maya');
	expect(host.textContent).toContain('Queen Official · G major');
	// A hero, not a list item: no seq bubble and no row geometry class. This is what "now-playing is a
	// hero, NOT a row" means structurally — reverting the hero to a QueueRow-shaped element reds here.
	expect(host.querySelector('.seq')).toBeNull();
	expect(host.querySelector('.qrow')).toBeNull();
	expect(host.querySelector('section.hero')).not.toBeNull();
});

test('the hero carries the singer identity colour on a dot that cannot collapse', () => {
	const host = render(NowPlayingHero, PLAYING);
	// the primitive-adoption pass: the four byte-identical identity dots became app.css's shared `.singer-dot`, which
	// is where `flex: 0 0 auto` — the "cannot collapse" half of this claim — now lives. The claim is
	// unchanged, and the shared rule is what QueueRow and ProcessingCard already read.
	const dot = host.querySelector('.eyebrow .singer-dot') as HTMLElement | null;
	expect(dot).not.toBeNull();
	// The colour arrives as the custom property the rule reads, so a long name cannot silently drop it.
	expect(dot!.getAttribute('style')).toContain('#33d6a6');
});

test('an unknown song length hides the progress row rather than pinning a bar at zero', () => {
	// durationSec 0 is the real shape for a local file or an older catalog row.
	const unknown = render(NowPlayingHero, { ...PLAYING, durationSec: 0 });
	expect(unknown.querySelector('.seekrow')).toBeNull();
	expect(unknown.querySelector('[role="progressbar"]')).toBeNull();

	// S6: the bar is <Progress> now — the same hand-rolled idiom lived in three components, and it
	// finally carries role="progressbar" with aria-valuenow. The claim is unchanged; the fill is found by
	// the vendored bar's data-slot rather than by `.track > i`.
	const known = render(NowPlayingHero, PLAYING);
	const bar = known.querySelector('[role="progressbar"]') as HTMLElement | null;
	expect(bar).not.toBeNull();
	// 30s of 120s is a quarter. Written out, not computed with progressFraction — the same operation
	// the component performs cannot be the source of the expectation (an earlier change).
	expect(bar!.getAttribute('aria-valuenow')).toBe('25');
	const fill = bar!.querySelector('[data-slot="progress-indicator"]') as HTMLElement | null;
	expect(fill).not.toBeNull();
	expect(fill!.getAttribute('style')).toContain('translateX(-75%)');
	// A transform, not width: a width animation triggers layout every frame, which motion.test.ts forbids.
	expect(fill!.getAttribute('style')).not.toContain('width:');
});

test('the transport is disabled when there is nothing for it to act on', () => {
	const empty = render(NowPlayingHero, { title: 'Nothing playing', hint: 'Queue a song to start the party' });
	const btn = (host: HTMLElement, label: string) =>
		host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
	expect(btn(empty, 'restart').disabled).toBe(true);
	expect(btn(empty, 'skip').disabled).toBe(true);
	expect(btn(empty, 'play/pause').disabled).toBe(true);
	// …but play stays live when a queue is waiting to start: "start when it is ready" is a real intent.
	const waiting = render(NowPlayingHero, { title: 'Nothing playing', canStart: true });
	expect(btn(waiting, 'play/pause').disabled).toBe(false);
	expect(btn(waiting, 'skip').disabled).toBe(true);

	const playing = render(NowPlayingHero, PLAYING);
	expect(btn(playing, 'restart').disabled).toBe(false);
	expect(btn(playing, 'skip').disabled).toBe(false);
});

/*
 * MOVED TO THE LAYOUT RUNG BY S5: 'the live controls render in the disclosure BODY, never in its
 * summary (XR-PH-15)'.
 *
 * The hero's disclosure is a Bits UI Collapsible now, which reads `getBoundingClientRect()` to publish
 * its content height. The mount rung replaces that accessor with a throw, because happy-dom fabricates
 * a zero and a fabricated zero is worse than no answer (XR-VER-03) — so the hero can no longer be
 * mounted here at all, and faking the geometry to keep this test would manufacture exactly the silent
 * green that refusal exists to prevent.
 *
 * Both halves of the claim now live in `tests/e2e/probes/p16-hero-live-controls.mjs`, against a
 * real render rather than a stub: that the disclosure starts closed with its summary standing in for
 * the controls and the control not visible, and that once opened the control sits in the body and never
 * inside the toggle. p16 is where the neighbouring XR-PH-15 and XR-PH-03 claims already live.
 */

test('no disclosure renders at all when there are no live controls to put in it', () => {
	const host = render(NowPlayingHero, PLAYING);
	expect(host.querySelector('.tools')).toBeNull();
});

test('an idle room offers no "adjust while you sing" — there is nothing to adjust', () => {
	// Found by looking at a driven idle frame, not by a test: the disclosure rendered over an empty
	// stage. The controls are LIVE controls for the playing song, so `hasSong` gates them.
	const idle = render(HeroWithControls, { hasSong: false, singerName: null, title: 'Nothing playing' });
	expect(idle.querySelector('.tools')).toBeNull();
	expect(idle.textContent).not.toContain('Adjust while you sing');
});

test('an idle hero says "Nothing playing" exactly once', () => {
	// The eyebrow names WHO is singing; with nobody singing it printed "Nothing playing" directly above
	// the title saying the same thing. Also a frame finding.
	const idle = render(NowPlayingHero, { title: 'Nothing playing', hint: 'Queue a song to start the party' });
	expect(idle.querySelector('.eyebrow')).toBeNull();
	expect((idle.textContent ?? '').match(/Nothing playing/g)?.length).toBe(1);
	expect(idle.textContent).toContain('Queue a song to start the party');
});

// ── the position card, and its honest degradation ────────────────────────────────────────────────
test('the position card states the ordinal, who you follow, and the wait (XR-PH-09)', () => {
	const host = render(MyPositionCard, {
		words: positionWords({ place: 3, beforeName: 'Sam', nowRemainingSec: 120, aheadDurationsSec: [200, 341] })
	});
	expect(host.querySelector('.big')?.textContent).toBe('3rd');
	expect(host.textContent).toContain("You're up after Sam.");
	expect(host.textContent).toContain('Roughly 11 minutes.');
	// The ordinal is a bare number on screen, so the card names itself for a screen reader.
	expect(host.querySelector('section')?.getAttribute('aria-label')).toBe('Your place in the queue');
});

test('an unknown wait renders NO minutes clause — not a zero, not a guess (XR-PH-09)', () => {
	const host = render(MyPositionCard, {
		words: positionWords({ place: 3, beforeName: 'Sam', nowRemainingSec: 120, aheadDurationsSec: [200, null] })
	});
	// The ordinal and the "after whom" half survive…
	expect(host.querySelector('.big')?.textContent).toBe('3rd');
	expect(host.textContent).toContain("You're up after Sam.");
	// …and the wait is ABSENT from the DOM, not an empty element holding a gap open.
	expect(host.querySelector('.wait')).toBeNull();
	const text = host.textContent ?? '';
	expect(text.toLowerCase()).not.toContain('roughly');
	expect(text.toLowerCase()).not.toContain('minute');
	expect(text).not.toContain('NaN');
	expect(text).not.toContain('null');
});

test('the card de-emphasises the wait with a token, never with subtree opacity (XR-PH-03)', () => {
	const host = render(MyPositionCard, {
		words: positionWords({ place: 2, beforeName: 'Maya', nowRemainingSec: 60, aheadDurationsSec: [] })
	});
	const wait = host.querySelector('.wait') as HTMLElement;
	expect(wait.textContent).toBe('Roughly 1 minute.');
	// happy-dom applies no stylesheet, so the assertion that bites is the absence of an INLINE opacity
	// on the rendered subtree; the stylesheet half is contrast.test.ts's tree-walk.
	for (const el of [host.querySelector('section')!, wait]) {
		expect(el.getAttribute('style') ?? '').not.toContain('opacity');
	}
});

test('a guest with nothing queued gets no card at all', () => {
	const host = render(MyPositionCard, { words: null });
	expect(host.querySelector('section')).toBeNull();
	expect((host.textContent ?? '').trim()).toBe('');
});

// ── the unconfirmed marker says which mutation it is waiting on (XR-PH-10) ───────────────────────
const ROW = {
	seq: 3,
	title: 'Wonderwall',
	singerName: 'You',
	singerColor: '#5cb8ff',
	mine: true,
	removable: true,
	reorderable: true,
	canUp: true,
	canDown: true
};

test('a pending REORDER says "moving…", never "adding…" (XR-PH-10)', () => {
	const moving = render(QueueRow, { ...ROW, pending: 'move' });
	expect(moving.textContent).toContain('moving…');
	expect(moving.textContent).not.toContain('adding…');

	// The add path is unchanged — this is a NEW state, not a renamed one.
	const adding = render(QueueRow, { ...ROW, pending: 'add' });
	expect(adding.textContent).toContain('adding…');
	expect(adding.textContent).not.toContain('moving…');

	// A confirmed row says neither.
	const settled = render(QueueRow, { ...ROW, pending: null });
	expect(settled.querySelector('.adding')).toBeNull();
});

test('a row awaiting confirmation makes its own reorder controls inert (XR-PH-10)', () => {
	// "…and its reorder controls are inert" is part of the requirement: a second tap on a move that has
	// not landed would issue a second op against a position the server has not agreed to yet.
	const moving = render(QueueRow, { ...ROW, pending: 'move' });
	expect(moving.querySelector('button[aria-label="move up"]')).toBeNull();
	expect(moving.querySelector('button[aria-label="move down"]')).toBeNull();
	expect(moving.querySelector('button[aria-label="remove from queue"]')).toBeNull();

	// …and they are present once confirmed, so the assertion above is about the pending state and not
	// about the props never rendering controls at all.
	const settled = render(QueueRow, { ...ROW, pending: null });
	expect(settled.querySelector('button[aria-label="move up"]')).not.toBeNull();
	expect(settled.querySelector('button[aria-label="move down"]')).not.toBeNull();
});

test('the pending state is signalled on the row SURFACE, not by dimming its subtree (XR-PH-03)', () => {
	const moving = render(QueueRow, { ...ROW, pending: 'move' });
	const root = moving.querySelector('.qrow') as HTMLElement;
	expect(root.className).toContain('pending');
	// happy-dom applies no stylesheet, so what bites here is an INLINE opacity on the rendered subtree;
	// the stylesheet half is contrast.test.ts's "no card root dims its own subtree with opacity".
	expect(root.getAttribute('style') ?? '').not.toContain('opacity');
});

// ── the gallery is where these states get looked at ──────────────────────────────────────────────
test('the gallery carries the hero and BOTH position branches, adjacent', () => {
	/*
	 * A fixture's absence is invisible to every runtime assertion in the suite, which is exactly how
	 * two earlier `pending` rules shipped unreadable: nothing ever rendered them, so nobody measured
	 * them. Same closure as that guard — scan the real gallery source.
	 *
	 * The PAIR is the point for the position card: "no minutes clause" is only judgeable against the
	 * clause it replaces, so a gallery with only the happy branch cannot show the degradation at all.
	 */
	const gallery = read('src/routes/components/+page.svelte');
	expect(gallery).toContain('<NowPlayingHero');
	expect(gallery).toContain('<MyPositionCard');
	// The imports too, separately: dropping one breaks `build` and leaves `bun test` green, so without
	// this the fixtures could be orphaned by a tidy-up that no named test objects to.
	expect(gallery).toMatch(/import NowPlayingHero from '\$lib\/components\/NowPlayingHero\.svelte';/);
	expect(gallery).toMatch(/import MyPositionCard from '\$lib\/components\/MyPositionCard\.svelte';/);
	expect(gallery).toMatch(/import \{ positionWords \} from '\$lib\/position-sentence';/);
	// An idle hero too — the empty state is a designed state (XR-PH-08), not an accident of no data.
	expect(gallery).toMatch(/<NowPlayingHero title="Nothing playing"/);

	const cards = [...gallery.matchAll(/<MyPositionCard[\s\S]*?\/>/g)].map((m) => m[0]);
	expect(cards.length).toBeGreaterThanOrEqual(2);
	// one branch where every duration ahead is known…
	expect(cards.some((c) => /aheadDurationsSec: \[\d+, \d+\]/.test(c))).toBe(true);
	// …and one where an entry ahead has none, which is the honest-degradation arm.
	expect(cards.some((c) => /aheadDurationsSec: \[[^\]]*null[^\]]*\]/.test(c))).toBe(true);
});
