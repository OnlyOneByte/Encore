// guard: a terminally failed process was rendered and acted on as if the singer held no queued turn —
// (F1) the retry the app advertises booked a SECOND turn of the same song, and (F2) the singer's queue
// card never said the process died. No jsdom for these surfaces, so both are decidable properties of the
// component source; the behavioural halves live in process-and-queue.test.ts and readiness.test.ts.
import { readFileSync } from 'node:fs';
import { test, expect } from 'bun:test';
import { at } from '@encore/test-support';
import { stripComments } from '@encore/test-support/scan';

const songRow = stripComments(readFileSync(at('src/lib/components/SongRow.svelte'), 'utf8'), {
	markup: true,
	drop: true
});
const processingCard = stripComments(readFileSync(at('src/lib/components/ProcessingCard.svelte'), 'utf8'), {
	markup: true,
	drop: true
});
const page = stripComments(readFileSync(at('src/routes/+page.svelte'), 'utf8'), { markup: true, drop: true });
const processAndQueue = stripComments(readFileSync(at('src/lib/process-and-queue.ts'), 'utf8'), {
	markup: true,
	drop: true
});
const readiness = stripComments(readFileSync(at('src/lib/readiness.ts'), 'utf8'), { markup: true, drop: true });

test('F1: the .sing button consumes inQueue via a retryProcess term (was silently discarded)', () => {
	const m = songRow.match(/const\s+retryProcess\s*=\s*\$derived\(([^;]*)\);/);
	expect(m).not.toBeNull(); // non-vacuous
	expect(m![1]).toMatch(/\bonmake\b/); // only the .sing (onmake) branch
	expect(m![1]).toMatch(/\binQueue\b/); // …and only when a turn is already queued
});

test('F1: the retry state reaches the sing markup (label, title and a visual signal)', () => {
	// The derived term is dead unless the template reads it. The aria-label must change (a bare mark otherwise
	// announces "Sing this", promising a turn the action no longer takes), and the state rides on a DATA ATTRIBUTE
	// because `class:` is invalid on a component and a class passed to one is stripped in the caller.
	expect(songRow).toMatch(/data-retry=\{retryProcess \? '' : undefined\}/);
	const label = songRow.match(/const\s+actionLabel\s*=\s*\$derived\(([\s\S]*?)\);/);
	expect(label).not.toBeNull();
	expect(label![1]).toMatch(/retryProcess/);
	const singBtn = songRow.match(/<Button\s+variant="iconPrimary"[\s\S]*?<\/Button>/);
	expect(singBtn).not.toBeNull();
	expect(singBtn![0]).not.toMatch(/\bdisabled\b/);
	expect(songRow).toMatch(
		/\.row :global\(\[data-slot='button'\]\[data-retry\]\)\s*\{[^}]*box-shadow[^}]*var\(--danger-line\)/
	);
});

test('F1: singThis passes hasQueuedTurn so the retry does not queue a second turn', () => {
	// The route must thread inMyQueue into processAndQueue's hasQueuedTurn, or the queue step always runs and the
	// double-turn bug stands regardless of the helper's logic.
	const m = page.match(/function\s+singThis\([\s\S]*?\n\t\}/);
	expect(m).not.toBeNull();
	expect(m![0]).toMatch(/hasQueuedTurn\s*:\s*inMyQueue\(mediaId\)/);
});

test('F1: ProcessAndQueueSteps declares the hasQueuedTurn field the retry reads', () => {
	expect(processAndQueue).toMatch(/hasQueuedTurn\?\s*:\s*boolean/);
});

test('F2: queueCardKind is exported from readiness with a failed verdict', () => {
	expect(readiness).toMatch(/export\s+function\s+queueCardKind\s*\(/);
	expect(readiness).toMatch(/export\s+type\s+QueueCardKind\s*=\s*'processing'\s*\|\s*'failed'\s*\|\s*'plain'/);
	expect(readiness).toMatch(/live\.status\s*===\s*'failed'[\s\S]*?'failed'/);
});

test('F2: the queue list selects its card via queueCardKind (not an in-flight-only test)', () => {
	// The entry chose ProcessingCard vs plain QueueRow via `processing(e.mediaId)`, which returned null for a failed
	// media — so a dead turn rendered as a plain waiting row.
	expect(page).toMatch(/queueCardKind\(mediaCatalog\.get\(e\.mediaId\),\s*mediaStatus\.get\(e\.mediaId\)\)/);
	expect(page).toMatch(/\{#if\s+card\s*===\s*'processing'\s*\|\|\s*card\s*===\s*'failed'\}/);
	const imp = page.match(/import\s*\{([\s\S]*?)\}\s*from\s*'\$lib\/readiness'/);
	expect(imp).not.toBeNull();
	expect(imp![1]).toMatch(/\bqueueCardKind\b/);
});

test('F2: the orphaned processing() predicate is gone (its null-on-failed test was the bug)', () => {
	// processing() was the failed-blind selector. Ban its discredited BODY too, not just the name: a status filter
	// excluding 'failed' alongside 'ready'/'canceled' is the shape that dropped a dead process.
	expect(page).not.toMatch(/function\s+processing\s*\(/);
	expect(page).not.toMatch(
		/status\s*!==\s*'ready'\s*&&\s*s\.status\s*!==\s*'failed'\s*&&\s*s\.status\s*!==\s*'canceled'/
	);
});

test('F2: ProcessingCard renders a distinct failed treatment', () => {
	const m = processingCard.match(/const\s+failed\s*=\s*\$derived\(([^;]*)\);/);
	expect(m).not.toBeNull();
	expect(m![1]).toMatch(/status\s*===\s*'failed'/);
	expect(processingCard).toMatch(/class:failed=\{failed\}/);
	expect(processingCard).toMatch(/\{#if\s+failed\}[\s\S]*?\{:else\}[\s\S]*?<Progress/);
	expect(processingCard).toMatch(/\.proc\.failed\s*\{[^}]*var\(--danger-line\)/);
});

test('F2: ProcessingCard suppresses the in-flight sparkle on a failed card', () => {
	// The sparkle means "work is happening": reverting this leaves it painting next to "Couldn't make karaoke".
	expect(processingCard).toMatch(/\{#if\s+!failed\}<span class="sparkle">/);
	expect(processingCard).toMatch(/\.stage\.bad\s*\{[^}]*var\(--danger-ink\)/);
	expect(processingCard).toMatch(/<div class="stage bad"[^>]*>\s*<span>\{stageLabel\}<\/span>\s*<\/div>/);
});
