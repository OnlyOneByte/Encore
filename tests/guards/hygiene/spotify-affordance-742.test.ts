// Guards for's rendered half — the phone must stop OFFERING an action it cannot honour.
//
// Encore has no jsdom for these surfaces, so — like song-row-tags.test.ts, song-row-sparkle-sibling
// and failed-process-turn-741.test.ts — every UI invariant here is a decidable property of the component
// source. The BEHAVIOURAL half (canProcess's verdict, processState's state, the route's arm) is pinned in
// spotify-not-processable-742.test.ts and not-processable-arm-742.test.ts; these guards pin that the source
// WIRES those decisions into the markup, which a unit test on a pure helper cannot see.
//
// Why BOTH actions have to go, not just Sing: SongRow's two branches are an either/or (`{#if onmake}`
// … `{:else}` a `.add` button), so withholding `onmake` alone falls straight through to a live
// "＋ Turn" — and a turn on a song that can never be processed is exactly the dead end this row's
// one-primary-action design exists to remove. The `{:else}` branch also fires `onadd?.()`, so a row
// passed neither callback would render an enabled control that silently does nothing.
//
// RE-POINTED for the phone-remote redesign. The Sing / turn affordances are on the surface that lists
// SEARCH RESULTS, and that moved out of `routes/+page.svelte` (home is queue-only now) into its own
// route, `routes/find/+page.svelte` — carrying `singThis`, `processMedia`, `readinessFor` and both
// SongRow blocks over unchanged. The three page-side arms below are asserted against /find; SongRow
// itself did not move. Same requirements, new address.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '@encore/test-support';

function stripComments(src: string): string {
	return src
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const ROOT = repoRoot;
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const songRowRaw = read('src/lib/components/SongRow.svelte');
const pageRaw = read('src/routes/find/+page.svelte');
const songRow = stripComments(songRowRaw);
const page = stripComments(pageRaw);

test('non-vacuous: both surfaces were really read and still contain their action wiring', () => {
	// A moved or renamed file must fail loudly here rather than letting every scan below pass on an
	// empty string.
	expect(songRowRaw.length).toBeGreaterThan(2000);
	expect(pageRaw.length).toBeGreaterThan(2000);
	expect(songRow).toMatch(/\{#if onmake\}/);
	expect(page).toMatch(/<SongRow/);
});

test('every Sing site asks a gate that can SEE the media, not readiness alone', () => {
	// The defect in one line: `canProcess(r)` answered a per-item capability from a check that could not
	// see `Media.source`, so a Spotify row offered Sing exactly like a YouTube row. Every call site must
	// now pass the media. Counting them is what stops a fix that converts one of the four and leaves the
	// other three — the shape was blocked for.
	const singSites = page.match(/onmake=\{canProcess\([^)]*\)/g) ?? [];
	// TWO sites since dropped the empty-box shortcut lists (Popular / Recently, which each rendered
	// a SongRow): the raw search-results block and the processing block. Counting them is what stops a fix
	// that converts one and leaves the other — the shape was blocked for.
	expect(singSites).toHaveLength(2);
	for (const site of singSites) {
		// two arguments, the first of which is a media expression (not a bare Readiness variable)
		expect(site).toMatch(/canProcess\(\s*[A-Za-z_$][\w.$]*\s*,\s*r\s*\)/);
	}
	// …and the readiness-only shape must be GONE from the template, or a fifth row could be added back
	// with the blind gate and no test would notice.
	expect(page).not.toMatch(/canProcess\(\s*r\s*\)/);
});

test('every row that can offer a turn also declares whether the song is processable at all', () => {
	// `processable` is what removes the ADD affordance. Same count as the Sing sites: since the raw
	// search-results block plus the processing block (the empty-box shortcut lists that used to add two
	// more were dropped). It must be derived from the shared authority, not re-implemented with a local
	// `source === 'spotify'` test — that is how the rule ended up enforced in one place and asserted in
	// several.
	const processableSites = page.match(/processable=\{isProcessableSource\([^)]*\)\}/g) ?? [];
	expect(processableSites).toHaveLength(2);
	expect(page).not.toMatch(/processable=\{[^}]*===\s*'spotify'/);
	// imported from the shared authority — pinned separately from the call sites so reverting only the
	// import (which would break the build rather than a test) is still caught by a named failure. That
	// authority is `src/lib/contract` (alias `$lib/contract`) since the restructure; it was the
	// `@encore/shared` package before, and only its ADDRESS moved — the claim is unchanged.
	const imports = page.match(/import\s*\{([^}]*)\}\s*from\s*'\$lib\/contract'/g) ?? [];
	expect(imports.join(' ')).toMatch(/\bisProcessableSource\b/);
});

test('SongRow disables the add button when the song can never be processed', () => {
	// Without this the row falls through from the withheld Sing branch to a live "＋ Turn" and books the
	// dead turn anyway — the fix would be cosmetic.
	// RE-ANCHORED when the control became `<Button variant="iconReady">`. Same claim, new spelling.
	const addBtn = songRow.match(/<Button\s+variant="iconReady"[\s\S]*?<\/Button>/);
	expect(addBtn).not.toBeNull();
	expect(addBtn![0]).toMatch(/disabled=\{inQueue\s*\|\|\s*!processable\}/);
	// the exact base shape must be gone, or the guard above could pass on a second add button elsewhere
	expect(songRow).not.toMatch(/disabled=\{inQueue\}/);
	// default true, so every existing caller keeps its behaviour and only an explicit false withholds
	expect(songRow).toMatch(/processable\s*=\s*true/);
});

test('the disabled add also LOOKS unavailable — disabled alone reads as broken', () => {
	// The add action carries the app's actionable signal (a green border and a green mark). A
	// full-strength green ＋ that does nothing when tapped reads as the app being broken, not as an action
	// that is unavailable — and on a phone there is no hover to reveal the `title` that explains it. So
	// the state needs a MARKER and a rule; reverting either leaves the other inert.
	//
	// RE-ANCHORED: `class:unavailable` could not survive the move to <Button> — a `class:` directive is
	// invalid on a component, and a class passed to one is stripped in the caller. The state is a data
	// attribute the component forwards, and the rule reaches it with an anchored `:global()`. The rule
	// must stay anchored under `.row`: unanchored it would neutralise every button in the app.
	const addBtn = songRow.match(/<Button\s+variant="iconReady"[\s\S]*?<\/Button>/);
	expect(addBtn![0]).toMatch(/data-row-state=\{inQueue \? 'queued' : !processable \? 'unavailable' : undefined\}/);
	const rule = songRow.match(/\.row :global\(\[data-slot='button'\]\[data-row-state='unavailable'\]\)\s*\{[^}]*\}/);
	expect(rule).not.toBeNull();
	// it must drop the accent, which is the whole point — a border colour change, not just opacity
	expect(rule![0]).toMatch(/border-color:\s*var\(--line\)/);
	expect(rule![0]).toMatch(/color:\s*var\(--ink-dim\)/);
	// and it must NOT borrow the danger family: nothing has gone wrong, and a red row would tell a guest
	// their search failed.
	expect(rule![0]).not.toMatch(/danger/);
});

test('SongRow SAYS why, on screen — a title attribute is unreachable on a phone', () => {
	// An unexplained disabled control reads as the app being broken. The reason has to be in the chip
	// line (rendered text), not only in `title`, because these rows are only ever used on a touch
	// surface where there is no hover.
	const chip = songRow.match(/const\s+stateChip\s*=\s*\$derived\.by\(\(\)\s*=>\s*\{[\s\S]*?\n\t\}\);/);
	expect(chip).not.toBeNull();
	expect(chip![0]).toMatch(/!processable/);
	// …and the branch must be the LAST word before the null fallthrough, so it can never mask a real
	// process state (ready / failed / processing are all decided above it).
	const order = chip![0];
	expect(order.indexOf("readiness === 'processing'")).toBeLessThan(order.indexOf('!processable'));
	expect(order.indexOf('!processable')).toBeLessThan(order.lastIndexOf('return null'));
	// the screen-reader label differs too, and says the reason rather than "Already in the queue"
	const label = songRow.match(/const\s+actionLabel\s*=\s*\$derived\(([\s\S]*?)\);/);
	expect(label).not.toBeNull();
	expect(label![1]).toMatch(/!processable/);
	// the not-processable label must be decided BEFORE the inQueue label, or a queued dead turn from an
	// earlier build would be announced as merely "already in the queue".
	expect(label![1].indexOf('!processable')).toBeLessThan(label![1].indexOf('inQueue'));
});
