// Guards for #741 — a terminally failed process was rendered and acted on as if the singer held no
// queued turn for that media, so (F1) the retry the app advertises booked a SECOND turn of the same
// song, and (F2) the singer's own queue card never said the process died. Encore has no jsdom for these
// two component surfaces, so — like song-row-tags.test.ts and the sparkle-sibling guard — every UI
// invariant here is a decidable property of the component source. The BEHAVIOURAL halves (the
// singThis decision and the queueCardKind selector) are pinned in process-and-queue.test.ts and
// readiness.test.ts; these guards pin that the source WIRES those decisions into the markup, which a
// unit test on a pure helper cannot see.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	return src
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const songRow = stripComments(readFileSync(join(import.meta.dir, 'SongRow.svelte'), 'utf8'));
const processingCard = stripComments(readFileSync(join(import.meta.dir, 'ProcessingCard.svelte'), 'utf8'));
const page = stripComments(readFileSync(join(import.meta.dir, '..', '..', 'routes', '+page.svelte'), 'utf8'));
const processAndQueue = stripComments(readFileSync(join(import.meta.dir, '..', 'process-and-queue.ts'), 'utf8'));
const readiness = stripComments(readFileSync(join(import.meta.dir, '..', 'readiness.ts'), 'utf8'));

// ── F1: the .sing branch must consume `inQueue`, and singThis must skip the queue step on a retry ──

test('#741 F1: the .sing button consumes inQueue via a retryProcess term (was silently discarded)', () => {
	// On base the .sing branch took no inQueue term at all — no disabled, no class, no alternate
	// label — while its .add sibling had all three. The retry state has to be DERIVED from inQueue,
	// or the button cannot tell a first tap from a re-process of a turn already held.
	const m = songRow.match(/const\s+retryProcess\s*=\s*\$derived\(([^;]*)\);/);
	expect(m).not.toBeNull(); // non-vacuous
	expect(m![1]).toMatch(/\bonmake\b/); // only the .sing (onmake) branch
	expect(m![1]).toMatch(/\binQueue\b/); // …and only when a turn is already queued
});

test('#741 F1: the retry state reaches the .sing markup (label, title and class)', () => {
	// The derived term is dead unless the template reads it. Its aria-label must change (a bare mark
	// otherwise announces "Sing this", promising a turn the action no longer takes), and it must carry
	// a class so the two states are not pixel-identical.
	expect(songRow).toMatch(/class:retry=\{retryProcess\}/);
	// actionLabel branches on retryProcess, so the screen-reader text differs on the retry.
	const label = songRow.match(/const\s+actionLabel\s*=\s*\$derived\(([\s\S]*?)\);/);
	expect(label).not.toBeNull();
	expect(label![1]).toMatch(/retryProcess/);
	// and the retry keeps the button ENABLED — the whole point of showing the failed state is that
	// the process can be retried (readiness.ts canProcess('failed')). A `disabled` on the sing button would
	// break the fix in the other direction.
	const singBtn = songRow.match(/<button\s+class="sing"[\s\S]*?<\/button/);
	expect(singBtn).not.toBeNull();
	expect(singBtn![0]).not.toMatch(/\bdisabled\b/);
	// the retry state is also visually distinct — a .sing.retry rule so a first tap and a re-process are
	// not pixel-identical. Reverting the CSS alone leaves class:retry inert.
	expect(songRow).toMatch(/\.sing\.retry\s*\{[^}]*box-shadow[^}]*var\(--danger-line\)/);
});

test('#741 F1: singThis passes hasQueuedTurn so the retry does not queue a second turn', () => {
	// The route must thread inMyQueue into processAndQueue's hasQueuedTurn, or the queue step always
	// runs and the double-turn bug stands regardless of the helper's logic.
	const m = page.match(/function\s+singThis\([\s\S]*?\n\t\}/);
	expect(m).not.toBeNull();
	expect(m![0]).toMatch(/hasQueuedTurn\s*:\s*inMyQueue\(mediaId\)/);
});

test('#741 F1: ProcessAndQueueSteps declares the hasQueuedTurn field the retry reads', () => {
	// A type-only hunk (the interface member) whose runtime effect is proven by process-and-queue.test.ts;
	// pinned here by source scan so reverting the declaration reds a test rather than only a typecheck.
	expect(processAndQueue).toMatch(/hasQueuedTurn\?\s*:\s*boolean/);
});

test('#741 F2: queueCardKind is exported from readiness with a failed verdict', () => {
	// The selector's runtime behaviour is proven in readiness.test.ts; this scan pins the exported
	// definition itself, so reverting the function (which only breaks the build in the prover) is
	// still caught as a named test failure.
	expect(readiness).toMatch(/export\s+function\s+queueCardKind\s*\(/);
	expect(readiness).toMatch(/export\s+type\s+QueueCardKind\s*=\s*'processing'\s*\|\s*'failed'\s*\|\s*'plain'/);
	// the failed live status must route to a failed card (not silently to plain).
	expect(readiness).toMatch(/live\.status\s*===\s*'failed'[\s\S]*?'failed'/);
});

// ── F2: the queue list must select a card via queueCardKind, and render a failed card ─────────────

test('#741 F2: the queue list selects its card via queueCardKind (not an in-flight-only test)', () => {
	// On base the entry chose ProcessingCard vs plain QueueRow with `processing(e.mediaId)`, which
	// returned null for a failed media — so a dead turn rendered as a plain waiting row. The selection
	// must go through queueCardKind, reading BOTH the catalog media and the live status.
	expect(page).toMatch(/queueCardKind\(mediaCatalog\.get\(e\.mediaId\),\s*mediaStatus\.get\(e\.mediaId\)\)/);
	// the processing-OR-failed entries render the ProcessingCard; only a plain card falls through.
	expect(page).toMatch(/\{#if\s+card\s*===\s*'processing'\s*\|\|\s*card\s*===\s*'failed'\}/);
	// queueCardKind must be IMPORTED from $lib/readiness — pinned separately from the call site so
	// reverting only the import (which would break the build) is still caught by a source scan.
	const imp = page.match(/import\s*\{([\s\S]*?)\}\s*from\s*'\$lib\/readiness'/);
	expect(imp).not.toBeNull();
	expect(imp![1]).toMatch(/\bqueueCardKind\b/);
});

test('#741 F2: the orphaned processing() predicate is gone (its null-on-failed test was the bug)', () => {
	// Pure deletion (§3): processing() was the failed-blind selector, and it had exactly one call site,
	// which now goes through queueCardKind. A literal-name scan is not enough here — the finding was
	// that the PREDICATE was wrong, not merely unused — so also ban its discredited body under any
	// name: a status filter that excludes 'failed' alongside 'ready'/'canceled' is the exact shape
	// that dropped a dead process to a plain row.
	expect(page).not.toMatch(/function\s+processing\s*\(/);
	expect(page).not.toMatch(
		/status\s*!==\s*'ready'\s*&&\s*s\.status\s*!==\s*'failed'\s*&&\s*s\.status\s*!==\s*'canceled'/
	);
});

test('#741 F2: ProcessingCard renders a distinct failed treatment', () => {
	// The card must be able to SAY the process died, not just render a stalled 0% bar. A `failed` term
	// derived from status, a class on the card, and the bar suppressed on that branch.
	const m = processingCard.match(/const\s+failed\s*=\s*\$derived\(([^;]*)\);/);
	expect(m).not.toBeNull();
	expect(m![1]).toMatch(/status\s*===\s*'failed'/);
	expect(processingCard).toMatch(/class:failed=\{failed\}/);
	// on the failed branch the progress bar is not rendered (a bar near 0 reads as a stalled process).
	// #913 S6: the bar is <Progress> now — same idiom, consolidated out of two components, and it
	// finally carries role="progressbar" with aria-valuenow. The claim is unchanged.
	expect(processingCard).toMatch(/\{#if\s+failed\}[\s\S]*?\{:else\}[\s\S]*?<Progress/);
	// and it takes the shared danger family, not a fourth palette.
	expect(processingCard).toMatch(/\.proc\.failed\s*\{[^}]*var\(--danger-line\)/);
});

test('#741 F2: ProcessingCard suppresses the in-flight sparkle on a failed card', () => {
	// The sparkle means "work is happening". A dead process has none, so it is gated behind !failed.
	// Reverting this leaves the sparkle painting next to "Couldn't make karaoke", which reads as a
	// process still in progress.
	expect(processingCard).toMatch(/\{#if\s+!failed\}<span class="sparkle">/);
	// the failed stage line takes the danger ink (the .stage.bad rule), not the in-flight --warn.
	expect(processingCard).toMatch(/\.stage\.bad\s*\{[^}]*var\(--danger-ink\)/);
	// and the failed branch renders the stage line WITHOUT a percentage (there is no progress %).
	expect(processingCard).toMatch(/<div class="stage bad"[^>]*>\s*<span>\{stageLabel\}<\/span>\s*<\/div>/);
});
