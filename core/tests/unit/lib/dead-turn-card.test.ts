import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';

/*
 * guard: the WIRING that makes `queueCardKind`'s stalled arm visible, which is where this fix can die silently.
 *
 * The arm itself is a pure function with real tests in readiness.test.ts. What cannot be reached from there — nor
 * from a browser, since each of these failures LOOKS LIKE the unfixed app — is the five lines of template and store
 * wiring between it and the screen. All four shapes below were identified before the change and are the reason this
 * file exists rather than a sixth Playwright assertion:
 *
 *  1. /queue's gate was an ENUMERATION of kinds (`card === 'processing' || card === 'failed'`). A new kind falls
 *     through its `{:else}` to a plain QueueRow — the bug survives its own fix, and an assertion on `.proc`/`.failed`
 *     keeps passing because those cards still render for the kinds that were already wired.
 *  2. the same block defaulted its live status to `{ status: 'failed' }`, dead code only while every non-plain kind
 *     required a live status. The moment one stopped requiring one it would hand every stranded turn the
 *     ran-and-failed copy — a visible card, with the wrong sentence in it.
 *  3. `ProcessingCard` had no `bornStage` guard on its polite region, which did not matter while a card needed a
 *     live status to exist. SongRow's own note measures the cost on /library: 63 `role=status` INSERTIONS on
 *     arrival against 3 removals. Arriving at /queue in the owner's room would have mounted ~89.
 *  4. the `unservable` flag already on the wire has to be carried through the store, or the phone keeps drawing a
 *     progress bar for a job the server has already said nobody can run.
 *
 * The component-mount harness is gone (bunfig.toml records why), so a source scan is what is available for the
 * template half. Each assertion names the SHAPE that failed, not just the shape that works.
 */

const queuePage = readFileSync(at('src/routes/queue/+page.svelte'), 'utf8');
const card = readFileSync(at('src/lib/components/ProcessingCard.svelte'), 'utf8');
const roomStore = readFileSync(at('src/lib/stores/room.ts'), 'utf8');

test('the /queue gate tests for NOT-plain, never for a list of card kinds', () => {
	expect(queuePage).toContain("{#if card !== 'plain'}");
	// The enumeration, in the exact shape it shipped in. A regression here renders a dead turn as a waiting row
	// again while every existing card assertion still passes.
	expect(queuePage).not.toContain("card === 'processing' || card === 'failed'");
	// And the kind reaches the component as the classifier's own answer rather than being re-derived from a status.
	expect(queuePage).toContain('kind={card}');
});

test('no invented live status: the card is handed what the map holds, including nothing', () => {
	expect(queuePage).toContain('status={live?.status}');
	// The fallback object, which would silently caption every stalled turn "Couldn't make karaoke".
	expect(queuePage).not.toContain("status: 'failed' as MediaStatus");
	/* The card's own side of the same contract: an absent status is a REAL state (the catalog says cooking, this
	   phone holds no broadcast — reachable whenever `refreshLibrary()` throws) and `queued` is the least-committal
	   honest stage for it, which is SongRow's rule for the identical gap. */
	expect(card).toContain("processStageLabel(status ?? 'queued')");
});

test('the stalled card draws no bar and no percentage', () => {
	/* There is no process, so any figure would be invented — a stronger reason than the failed card's "a bar near 0
	   reads as slow rather than stopped". The `{:else if stalled}` arm must therefore sit between the failed arm and
	   the one that renders `<Progress>`. */
	expect(card).toMatch(/\{:else if stalled\}[\s\S]{0,400}<div class="stage"><span>\{stageLabel\}<\/span><\/div>/);
	// And the sparkle is gated on the IN-FLIGHT kind, not on `!failed`: a mark meaning "something is happening to
	// this song" on a turn nothing is happening to is the same lie in a smaller place.
	expect(card).toContain('{#if inFlight}<span class="sparkle">');
	expect(card).not.toContain('{#if !failed}<span class="sparkle">');
});

test('the polite region speaks on a CHANGE of stage, never on mount', () => {
	// SongRow's guard, ported. Without it, arriving at /queue inserts one `role=status` per stranded turn, all
	// reading the same sentence.
	expect(card).toContain('const bornStage = untrack(() => stageLabel);');
	expect(card).toContain('{#if stageLabel && stageLabel !== bornStage}');
	// The unguarded shape this replaces, which is what made every mounted card a dynamic insertion.
	expect(card).not.toMatch(/^<div class="vh" role="status">\{stageLabel\}<\/div>/m);
});

test('the retry is wired to every kind nothing is making karaoke for, and keeps the turn', () => {
	// Stalled AND failed: a failed card with no retry left the "try again" notice pointing at nothing.
	expect(queuePage).toContain("onretry={card !== 'processing' ? () => retryKaraoke(e.mediaId) : undefined}");
	// The process ALONE — the turn already exists, so nothing here may add a second one.
	expect(queuePage).toContain('void room.requestProcess(mediaId);');
	expect(queuePage).not.toMatch(/retryKaraoke[\s\S]{0,400}store\?\.addSong/);
	// Ungated by ownership, deliberately: a retry destroys nothing, where `onremove` is `singerId === me?.id`. Shown
	// while the route offers it, and held (disabled) through the tap's own hold, when the route stops offering it.
	expect(card).toContain('const showRetry = $derived(!!onretry || retrying);');
	expect(card).toContain('{#if showRetry}');
});

test('two comments that the retry would have made FALSE are rewritten', () => {
	/* A comment stating something false is a defect, and both of these were true only while the actions cluster
	   held one control and the retry lived on SongRow alone. */
	expect(card).not.toContain('REMOVE is the only control this cluster ever holds');
	expect(card).not.toContain('the RETRY lives on SongRow, not here');
});

test('the store carries `unservable` through to the card kind', () => {
	// On the wire already (`media:status`), read by the TV's `processIsTerminal` all along, discarded by the phone.
	expect(roomStore).toContain('const { mediaId, status, pct, etaSec, unservable } = e;');
	expect(roomStore).toContain('next.set(mediaId, { status, pct, etaSec, unservable });');
	// The four-field destructure that dropped it, which is the shape that drew a live bar for a dead job.
	expect(roomStore).not.toContain('const { mediaId, status, pct, etaSec } = e;');
});

test("a dead card's line AND look follow the ROOM's maker verdict, whatever its kind (ruling 38)", () => {
	// Failed and stalled alike: a phone that missed the failure says what the phones that heard it say, and with no
	// maker every dead card says what the strip and the TV say.
	expect(card).toContain("const dead = $derived(kind === 'stalled' || kind === 'failed');");
	expect(card).toMatch(/dead\s*\?\s*\(noMaker\s*\?\s*STALLED_TURN_LABEL\s*:\s*processStageLabel\('failed'\)\)/);
	// Same words, same tone: the danger look goes with "Couldn't make karaoke", the warn look with the stalled line.
	expect(card).toContain('const failed = $derived(dead && !noMaker);');
	expect(card).toContain('const stalled = $derived(dead && noMaker);');
	// The split this replaced: a failed card that ignored the verdict.
	expect(card).not.toMatch(/kind === 'failed'\s*\?\s*processStageLabel\('failed'\)/);
	// The verdict is the same fold the TV lobby and the strip word their lines from, over the same queued turns.
	expect(queuePage).toMatch(/const noMaker = \$derived\(\s*waitingTurns\(\s*queued,/);
	expect(queuePage).toContain('noMaker={noMaker}');
});
