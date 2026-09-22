// — a song with no words must SAY so on the stage, and must not say so at any other time.
//
// The silence this replaces was the loudest half of a real owner report: "the karaoke text isn't
// showing" was indistinguishable from a broken renderer, a broken pipeline and a CSS regression,
// because `{#if show && doc && curLine}` had no `{:else}` and absence had no on-screen representation
// anywhere. The dominant cause is upstream and deliberate — an align job that cannot run (no
// WhisperX-capable worker) settles the media's lyrics gate as DONE with no `lyricsRef`, so the song is
// singable and wordless forever — so the overlay cannot fix it and must instead explain it.
//
// Mounted rather than source-scanned, because the risk here is a condition that is subtly too broad:
// a notice that also fires between lines, or during the fetch, would be worse than the silence.
import { test, expect, afterEach } from 'bun:test';
import { mount, unmount, flushSync } from '$setup/svelte-client';
import LyricsOverlay from '$lib/tv/LyricsOverlay.svelte';
import type { LyricsDoc } from '$lib/tv/lyrics';

let live: Array<{ comp: unknown; host: HTMLElement }> = [];
afterEach(() => {
	for (const { comp, host } of live) {
		void unmount(comp as never);
		host.remove();
	}
	live = [];
});

function render(props: Record<string, unknown>): HTMLElement {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const comp = mount(LyricsOverlay as never, { target: host, props });
	flushSync();
	live.push({ comp, host });
	return host;
}

// A doc whose line list is EMPTY. This is the one doc shape that exercises the notice's `!doc` term
// without rendering the reel, and staying off the reel matters: `measureReel` reads `offsetHeight`,
// which the harness makes throw LOUDLY on purpose (happy-dom has no layout engine and
// would otherwise fabricate a zero), so reel rendering is a LAYOUT-rung concern proven through
// tests/e2e/driver.mjs, not here. Note that `activeLineIndex` returns -1 only for an empty list — for
// a populated doc it clamps to the preceding line rather than going null in a gap, so there is no
// "between lines" doc that leaves the reel unrendered.
const EMPTY_DOC = { lines: [] } as unknown as LyricsDoc;

test('a song with NO lyrics artifact says so on the stage', () => {
	// No `lyricsRef` at all — the align-never-ran cohort. Nothing is in flight, so this is settled the
	// moment the overlay sees it.
	const host = render({ lyricsRef: undefined, positionSec: 7, playing: true, visible: true });
	expect(host.querySelector('.no-lyrics'), 'the notice should render').toBeTruthy();
	expect(host.textContent).toContain('No lyrics for this one');
	// And it does not pretend to be the reel.
	expect(host.querySelector('.viewport')).toBeFalsy();
});

test('a truthy doc suppresses the notice even when no line is current', () => {
	// The `!doc` term. With words present the stage must stay BLANK when nothing is active — that is
	// most of a song's running time — and must never be "explained".
	const host = render({ doc: EMPTY_DOC, positionSec: 7, playing: true, visible: true });
	expect(host.querySelector('.no-lyrics'), 'the notice must not fire when a doc exists').toBeFalsy();
	expect(host.textContent ?? '').not.toContain('No lyrics for this one');
});

test('the notice is suppressed while the artifact is still being fetched', () => {
	// A ref is present and nothing has settled for it yet, so words may still arrive. Flashing a
	// "no lyrics" notice during every song's load would be worse than the silence it replaces.
	// `fetch` is unstubbed here, so the request cannot have resolved by the synchronous flush.
	const host = render({ lyricsRef: 'derived/lyrics/m1.json', positionSec: 7, playing: true, visible: true });
	expect(host.querySelector('.no-lyrics'), 'the notice must not fire mid-fetch').toBeFalsy();
});

test('the notice is suppressed on the attract screen, where there is no song', () => {
	// `visible` is false between turns and on the idle stage. There is nothing to explain there.
	const host = render({ lyricsRef: undefined, positionSec: 0, playing: false, visible: false });
	expect(host.querySelector('.no-lyrics')).toBeFalsy();
});
