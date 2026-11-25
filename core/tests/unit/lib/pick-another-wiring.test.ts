import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';

/*
 * guard: the WIRING of "Pick another, keep your spot" — the op itself is tested in
 * replace-media-keeps-the-spot.test.ts. Both breaks below look like a working app until the spot is lost or someone
 * else's song is swapped, and before this file only probe p21 caught them. Source scans, because the
 * component-mount harness is gone (bunfig.toml records why).
 */

const home = readFileSync(at('src/routes/+page.svelte'), 'utf8');
const queuePage = readFileSync(at('src/routes/queue/+page.svelte'), 'utf8');

test('in replace mode Sing swaps the turn, carrying the NEW song key, and never adds a second turn', () => {
	// The NEW song's key: its last finished turn's (Your songs), else this phone's memory of it.
	expect(home).toContain('const key = last?.keyShift ?? rememberedKey(mediaId);');
	expect(home).toContain('store?.replaceMedia(replacing.id, mediaId, key ?? 0);');
	// The swap returns before the add, so one tap cannot do both.
	expect(home).toMatch(/if \(replacing\) \{[\s\S]{0,500}return;\s*\}\s*store\?\.addSong\(/);
	// Replace mode is only ever MY waiting turn.
	expect(home).toContain('queued.find((e) => e.id === id && e.singerId === me?.id)');
});

test('Pick another is offered on my own dead cards only', () => {
	expect(queuePage).toMatch(
		/pickAnotherHref=\{card !== 'processing' && e\.singerId === me\?\.id\s*\? pickAnotherHref\(resolve\('\/'\), e\.id\)\s*: undefined\}/
	);
});

const roomStore = readFileSync(at('src/lib/stores/room.ts'), 'utf8');
const layout = readFileSync(at('src/routes/+layout.svelte'), 'utf8');

test("the swap dismisses the dead song's notice by its id, and no other notice", () => {
	// The failure notice carries an id the swap can name...
	expect(roomStore).toMatch(/— try again\.`,\s*'error',\s*failureNoticeId\(mediaId\)\s*\);/);
	expect(layout).toContain('toast.error(message, { duration: 4000, id });');
	// ...and /queue, where the dead card says the same words over its own buttons, shows none and takes one down.
	expect(layout).toContain("if (page.url.pathname === '/queue') return;");
	expect(layout).toMatch(
		/if \(page\.url\.pathname !== '\/queue'\) return;\s*for \(const id of failureNotices\) toast\.dismiss\(id\);/
	);
	// ...read before the optimistic op rewrites the entry `replacing` derives from.
	expect(home).toMatch(/const deadMediaId = replacing\.mediaId;\s*(\/\/[^\n]*\n\s*)?store\?\.replaceMedia\(/);
	expect(home).toContain('toast.dismiss(failureNoticeId(deadMediaId));');
	// A bare dismiss() also took out any unrelated refusal shown at the same moment.
	expect(home).not.toContain('toast.dismiss();');
});

test('with no maker, the idle Sing tab drops the promise to make karaoke for any song', () => {
	// The join screen on `/` keeps the plain title; the Sing tab and Pick another get their own.
	expect(home).toContain(
		"{status === 'not-joined' ? 'Encore' : replacing ? 'Pick another · Encore' : 'Sing · Encore'}"
	);
	// Neither line until the verdict is known (library read + first queue sync), both in one reserved cell.
	// `onlyReady` is no maker OR no fetcher (proposal 24): the promise is about search results.
	expect(home).toMatch(/<span class:shown=\{verdictKnown && !onlyReady\}\s*>Find any song and we'll make/);
	expect(home).toMatch(/<span class:shown=\{verdictKnown && onlyReady\}\s*>Only ready songs can play right now\./);
	expect(home).toContain('verdictKnown = room.libraryLoaded && (room.queue?.synced ?? false);');
});

const library = readFileSync(at('src/routes/library/+page.svelte'), 'utf8');
const card = readFileSync(at('src/lib/components/ProcessingCard.svelte'), 'utf8');

test('with no maker, the Library tab drops the promise to make karaoke too', () => {
	// Neither line until the first queue sync (the fold `noMaker` reads), both in one reserved cell.
	expect(library).toMatch(
		/<span class:shown=\{queueSynced && !noMaker\}\s*>Find a song on the Sing tab and we'll make/
	);
	expect(library).toMatch(/<span class:shown=\{queueSynced && noMaker\}\s*>Can't make new karaoke right now\./);
	// The link's own verdict, verbatim — the derivation is tested in room-no-maker.test.ts.
	expect(library).toContain('noMaker = room.noMaker;');
});

test('Try again on a dead card answers at once, then follows the real status', () => {
	// The tap goes through `retry`, which swaps the line before the request, and holds the button while it shows.
	expect(card).toContain('onclick={retry}>Try again</Button');
	expect(card).toMatch(/function retry\(\) \{\s*retrying = true;/);
	expect(card).toContain('disabled={retrying}');
	expect(card).toMatch(/retrying\s*\?\s*RETRYING_LABEL/);
	// During the hold the card claims nothing measured: no bar, no sparkle — then it follows the server. A failed
	// card leaves its failed look for the hold too, or it reads "Couldn't make karaoke" under "Trying again…".
	expect(card).toContain('const failed = $derived(dead && !noMaker && !retrying);');
	expect(card).toContain('const stalled = $derived((dead && noMaker) || retrying);');
	expect(card).toContain("const inFlight = $derived(kind === 'processing' && !retrying);");
	expect(card).toContain('retryTimer = setTimeout(() => (retrying = false), RETRY_ACK_MS);');
	// …or sooner, on a verdict only: the decision is `retryHoldAfter` (retry-hold.test.ts), fed the status the tap was
	// made over.
	expect(card).toContain('heldOver = status;');
	expect(card).toContain('const next = retryHoldAfter(heldOver, status);');
	// The change of line pops in with the app's own keyframe at a motion token, never on mount.
	expect(card).toContain('{#key stageLabel}<div class="progress" class:stage-in={stageLabel !== bornStage}>');
});

test('a disabled LINK Button looks and acts disabled, as a disabled <button> does (Pick another in the hold)', () => {
	const button = readFileSync(at('src/lib/components/ui/button/button.svelte'), 'utf8');
	// `disabled:` matches a real <button> only; the link is disabled by `aria-disabled` and a dropped href.
	expect(button).toContain(
		'[&:is(a)[aria-disabled=true]]:pointer-events-none [&:is(a)[aria-disabled=true]]:opacity-50'
	);
	expect(button).toContain('aria-disabled={disabled}');
	// Never a bare `aria-disabled:`: the reorder grip is a <button> that sets it while staying live.
	expect(button).not.toMatch(/(^|\s)aria-disabled:opacity/);
});
