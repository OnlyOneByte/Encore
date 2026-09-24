// guard: the phone must stop OFFERING an action it cannot honour — a Spotify row was offered Sing exactly
// like a YouTube row. No jsdom for these surfaces, so every UI invariant is a decidable property of the
// component source; the behavioural half is pinned in spotify-not-processable.test.ts. BOTH actions have to
// go, not just Sing: SongRow's branches are an either/or, so withholding `onmake` alone falls through to a
// live "＋ Turn", and the `{:else}` fires `onadd?.()`, so a row passed neither callback no-ops when tapped.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '@encore/test-support';
import { stripComments } from '@encore/test-support/scan';

const ROOT = repoRoot;
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const songRowRaw = read('src/lib/components/SongRow.svelte');
const pageRaw = read('src/routes/+page.svelte');
const songRow = stripComments(songRowRaw, { markup: true, drop: true });
const page = stripComments(pageRaw, { markup: true, drop: true });

test('non-vacuous: both surfaces were really read and still contain their action wiring', () => {
	expect(songRowRaw.length).toBeGreaterThan(2000);
	expect(pageRaw.length).toBeGreaterThan(2000);
	expect(songRow).toMatch(/\{#if onmake\}/);
	expect(page).toMatch(/<SongRow/);
});

test('every Sing site asks a gate that can SEE the media, not readiness alone', () => {
	// The defect in one line: `canProcess(r)` answered a per-item capability from a check that could not see
	// `Media.source`. Every call site must now pass the media, and the readiness-only shape must be GONE.
	const singSites = page.match(/onmake=\{canProcess\([^)]*\)/g) ?? [];
	expect(singSites).toHaveLength(2);
	for (const site of singSites) {
		expect(site).toMatch(/canProcess\(\s*[A-Za-z_$][\w.$]*\s*,\s*r\s*\)/);
	}
	expect(page).not.toMatch(/canProcess\(\s*r\s*\)/);
});

test('every row that can offer a turn also declares whether the song is processable at all', () => {
	// `processable` removes the ADD affordance, same count as the Sing sites, and must derive from the shared
	// authority rather than a re-implemented local `source === 'spotify'` test.
	const processableSites = page.match(/processable=\{isProcessableSource\([^)]*\)\}/g) ?? [];
	expect(processableSites).toHaveLength(2);
	expect(page).not.toMatch(/processable=\{[^}]*===\s*'spotify'/);
	const imports = page.match(/import\s*\{([^}]*)\}\s*from\s*'\$lib\/contract'/g) ?? [];
	expect(imports.join(' ')).toMatch(/\bisProcessableSource\b/);
});

test('SongRow disables the add button when the song can never be processed', () => {
	// Without this the row falls through from the withheld Sing branch to a live "＋ Turn" and books the dead turn
	// anyway — the fix would be cosmetic. The exact base shape must be gone too, or a second add button elsewhere
	// would satisfy the arm.
	const addBtn = songRow.match(/<Button\s+variant="iconReady"[\s\S]*?<\/Button>/);
	expect(addBtn).not.toBeNull();
	expect(addBtn![0]).toMatch(/disabled=\{inQueue\s*\|\|\s*!processable\}/);
	expect(songRow).not.toMatch(/disabled=\{inQueue\}/);
	expect(songRow).toMatch(/processable\s*=\s*true/);
});

test('the disabled add also LOOKS unavailable — disabled alone reads as broken', () => {
	// A full-strength green ＋ that does nothing when tapped reads as the app being broken rather than as an action
	// that is unavailable, and on a phone there is no hover to reveal the `title`. So the state needs a MARKER and a
	// rule; reverting either leaves the other inert. `class:` is invalid on a component, hence the data attribute
	// plus a :global() ANCHORED under `.row` — unanchored it neutralises every button. It drops the accent (a
	// border-colour change, not opacity) and must NOT borrow the danger family: nothing has gone wrong.
	const addBtn = songRow.match(/<Button\s+variant="iconReady"[\s\S]*?<\/Button>/);
	expect(addBtn![0]).toMatch(/data-row-state=\{inQueue \? 'queued' : !processable \? 'unavailable' : undefined\}/);
	const rule = songRow.match(/\.row :global\(\[data-slot='button'\]\[data-row-state='unavailable'\]\)\s*\{[^}]*\}/);
	expect(rule).not.toBeNull();
	expect(rule![0]).toMatch(/border-color:\s*var\(--line\)/);
	expect(rule![0]).toMatch(/color:\s*var\(--ink-dim\)/);
	expect(rule![0]).not.toMatch(/danger/);
});

test('SongRow SAYS why, on screen — a title attribute is unreachable on a phone', () => {
	// An unexplained disabled control reads as broken. The reason has to be in the chip line (rendered text), not
	// only in `title`: these rows are only ever used on a touch surface where there is no hover.
	const chip = songRow.match(/const\s+stateChip\s*=\s*\$derived\.by\(\(\)\s*=>\s*\{[\s\S]*?\n\t\}\);/);
	expect(chip).not.toBeNull();
	expect(chip![0]).toMatch(/!processable/);
	// …and the branch must be the LAST word before the null fallthrough, so it can never mask a real process state,
	// while its label is decided BEFORE the inQueue one — or a queued dead turn from an earlier build would be
	// announced as merely "already in the queue".
	const order = chip![0];
	expect(order.indexOf("readiness === 'processing'")).toBeLessThan(order.indexOf('!processable'));
	expect(order.indexOf('!processable')).toBeLessThan(order.lastIndexOf('return null'));
	const label = songRow.match(/const\s+actionLabel\s*=\s*\$derived\(([\s\S]*?)\);/);
	expect(label).not.toBeNull();
	expect(label![1]).toMatch(/!processable/);
	expect(label![1].indexOf('!processable')).toBeLessThan(label![1].indexOf('inQueue'));
});
