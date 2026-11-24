import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';

/*
 * guard: /song/[mediaId] REPORTS what happens to a re-pick, and says each thing exactly once.
 *
 * The behaviour lives in a browser (tests/playwright/specs/probe/p18-song-page.spec.ts drives the real 409, the
 * re-read and the retry) and in the store (tests/unit/lib/stores/room-reselect-lyrics.test.ts owns the boolean).
 * What is here is the handful of wirings that are invisible to both: a disposer that only leaks across
 * navigations, a toast whose absence is the fix, and two shapes that would silently come back on the next edit
 * to these files.
 *
 * The component-mount harness was deleted (see bunfig.toml), so this is a source scan on purpose rather than for
 * want of a renderer.
 */

const songPage = readFileSync(at('src/routes/song/[mediaId]/+page.svelte'), 'utf8');
const reselect = readFileSync(at('src/lib/components/LyricsReselect.svelte'), 'utf8');

test('the page leaves the link error channel to the layout', () => {
	/* This route is the only caller of `reselectLyrics`, so its 401/409/400 refusals need a listener: the root
	   layout's one sink (ui-sweep-wiring.test.ts). A second registration here would toast each refusal twice. */
	expect(songPage).not.toContain('room.onError(');
});

test('the load error is announced once — the inline alert, never also a toast', () => {
	// `loadError` is rendered in a `role="alert"`; `toast.error(failed, …)` beside it said the same sentence a
	// second time. The store channel's toast lives in the layout, so this page raises none.
	expect(songPage).not.toMatch(/toast\.error\(/);
	// And the arm carries a control, which is the other half: it used to be a bare `<p>` with nothing to act on.
	expect(songPage).toContain('<Button variant="link" onclick={() => void load(mediaId)}>Try again</Button>');
});

test('the self-write re-read is QUIET: no skeleton, and no error arm from a blipped refresh', () => {
	expect(songPage).toContain('async function load(id: string, quiet = false)');
	// The three self-write sites (pick, paste, Undo/Back to automatic) pass it, and only they do — the arrival
	// path must still show the skeleton.
	expect(songPage.match(/load\(songId, true\)/g)).toHaveLength(3);
	expect(songPage).toContain('void load(mediaId)');
	/* The commit a quiet pass makes: the row if it got one, and nothing else. Flipping `loading` would unmount
	   LyricsReselect and collapse the disclosure the guest is standing in; writing `loadError` would replace a
	   working screen with an apology because one refresh missed. */
	expect(songPage).toMatch(/if \(quiet\) \{\s*if \(row\) \{\s*media = row;\s*lyricsUndo = undo;\s*\}\s*return;\s*\}/);
});

test('a refusal releases the pending flag, since nothing is broadcast for one', () => {
	// The server publishes `media:status` only when it accepts, so `justPicked` has no other way back down and
	// the control would stay disabled + aria-busy until a reload.
	expect(songPage.match(/else justPicked = false;/g)).toHaveLength(2);
	// Both callbacks await the boolean. `onpaste` additionally hands it on, for the draft the control keeps.
	expect(songPage).toContain(
		'if (await room.reselectLyrics(songId, { ref, rev: media?.lyricsEditRev ?? 0 })) await load(songId, true);'
	);
	expect(songPage).toContain('const ok = await room.reselectLyrics(songId, { text, rev: media?.lyricsEditRev ?? 0 });');
	expect(songPage).toContain('return ok;');
});

test('the control confirms the tap it received, and keeps a refused paste', () => {
	// The pending rung comes FIRST, so it outranks the provenance labels while the re-time runs.
	expect(reselect).toMatch(/\$derived\(\s*pending\s*\? 'Re-timing the words…'/);
	/* `open = false` is gone entirely: collapsing the disclosure on a refusal read as faint acceptance AND
	   discarded the pasted verse. The guest opened it; the guest closes it. */
	expect(reselect).not.toContain('open = false');
	expect(reselect).toContain('if ((await onpaste?.(text)) === false) return;');
});
