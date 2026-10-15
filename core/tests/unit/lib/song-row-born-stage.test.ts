import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';
import { processStageLabel } from '$lib/phrasing/process-phrasing';

/*
 * guard: a SongRow announces the stage it CHANGED INTO, never the stage it was BORN in.
 *
 * The region exists for one thing — "THE STAGE TRANSITION IS THE ANNOUNCEMENT" — and was gated on the stage
 * merely EXISTING. /library hands every row `readiness="ready"`, so every row there was born with a non-empty
 * stage and mounted a polite live region whose text it would never change — one per rendered row. Measured on a
 * 135-song library at 390x844 with 60 rows on arrival: a MutationObserver armed before the tab tap counted 63
 * `role=status` insertions against 3 removals, so they are dynamic insertions rather than page-load content, and
 * the same drive with the gate in place counts 3 and 3. `.vh` is clip-based, so each region also stayed in the
 * accessibility tree beside the visible pill, putting "Karaoke ready" in the tree twice per row; the fixed tree
 * reads 270 non-ignored AX nodes naming it for 135 rows, and `innerText` holds it 135 times rather than 270.
 *
 * Two things here are easy to break by accident. The GATE: dropping the `!== bornStage` term restores the wall.
 * And the CAPTURE: `bornStage` must be non-reactive and declared below `announcedStage`, or it either tracks the
 * value it exists to remember or trips the checker's block-scoped-use rule.
 */

const songRow = readFileSync(at('src/lib/components/SongRow.svelte'), 'utf8');
const library = readFileSync(at('src/routes/library/+page.svelte'), 'utf8');
const home = readFileSync(at('src/routes/+page.svelte'), 'utf8');
const roomStore = readFileSync(at('src/lib/stores/room.ts'), 'utf8');

test('the live region is gated on a CHANGE of stage, not on having one', () => {
	expect(songRow).toContain('{#if announcedStage && announcedStage !== bornStage}');
	// The region itself is unchanged — clipped, polite, and carrying the stage rather than the percentage.
	expect(songRow).toContain('<div class="vh" role="status">{announcedStage}</div>');
	// Exactly one such region per row. A second would be a second announcement of one transition.
	expect(songRow.match(/role="status"/g)).toHaveLength(1);
});

test('bornStage is captured once, untracked, and below the value it remembers', () => {
	expect(songRow).toContain('const bornStage = untrack(() => announcedStage);');
	expect(songRow).toMatch(/^\timport \{ untrack \} from 'svelte';$/m);
	// NOT `$derived`/`$state` — a reactive capture would follow the stage and the two could never differ.
	expect(songRow).not.toMatch(/bornStage = \$(derived|state)/);
	// Declared AFTER `announcedStage`: $derived is lazy at runtime, but svelte-check reports a block-scoped use
	// before declaration, which is the same ordering rule `metaFacts` already records in this file.
	expect(songRow.indexOf('const announcedStage')).toBeLessThan(songRow.indexOf('const bornStage'));
});

test('/library is the surface this was for: every row is born ready and can never transition', () => {
	// The premise. If /library ever stops hardcoding readiness, the region there becomes meaningful again and
	// this guard's reasoning — not its assertions — needs re-reading.
	expect(library).toContain('readiness="ready"');
	expect(library).not.toContain('readiness={');
	// The duplicate the fix removes is the PILL's own text, which is the same string by construction.
	expect(processStageLabel('ready')).toBe('Karaoke ready');
});

test('the documented announcement on `/` still has a changed stage to report', () => {
	/* Why the narrowing does not silence the case the region was written for. A raw search row is born with an
	   EMPTY stage (its readiness is neither processing, failed nor ready), and the optimistic mark flips it to
	   processing in place: `processingRows` is fed only by the search response's `j.processing`, which
	   `setMediaStatus` never writes to, so the row stays in the same keyed group and keeps its component
	   instance. bornStage is '' there, so both the in-flight stage and then "Karaoke ready" differ from it and
	   speak — driven on `/`, where one tap on a "Needs karaoke" row's sing action inserted a `role=status` reading
	   "Making karaoke…" against zero regions before it. */
	/* THE OPTIMISTIC MARK MOVED, and only its home did: /queue's stalled-card retry needed the same request, so
	   `processMedia` on `/` is now a haptic plus `room.requestProcess(mediaId)`, and the set lives inside that
	   method — still BEFORE the await, which is the property this reasoning rests on. Pinned in both places, since
	   either half going missing silences the transition this test is about. */
	expect(home).toContain('await room.requestProcess(mediaId);');
	expect(roomStore).toContain("this.setMediaStatus(mediaId, { status: 'queued', pct: 0 });");
	expect(home).toContain('const ids = processingGroupIds(processingResults);');
	expect(home).toMatch(/processingResults = j\.processing \?\? \[\];/);
	/* Both groups are keyed by media id, so a row that changes stage is updated rather than replaced. The SOURCE
	   of each `{#each}` is now that group's WINDOW rather than the full list — `/` windows its three result groups
	   the way /library windows its match list — which changes nothing this test reasons about: the key is still
	   the media id, the window is a prefix of the same list, and a row inside it keeps its component instance
	   across a stage change. What WOULD matter is the key, so that is what these pin. */
	expect(home).toContain('{#each processingView.shown as c (c.id)}');
	expect(home).toContain('{#each rawView.shown as m (m.id)}');
	// And the two stages a real transition moves between are distinct strings, which is what the gate compares.
	// The in-flight one is PINNED rather than only compared, because the comment above quotes it.
	expect(processStageLabel('queued')).toBe('Making karaoke…');
	expect(processStageLabel('queued')).not.toBe(processStageLabel('ready'));
});
