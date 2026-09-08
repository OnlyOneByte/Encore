// Guard for issue #304: the QueueRow/ProcessingCard "adding…" pending affordance must read the
// store's REAL pending map, not the placeholder rotationSeq (Number.MAX_SAFE_INTEGER) that
// applyAndReseq overwrites in the same synchronous frame as the add.
//
// The dead code the issue documents: addSong() stamps rotationSeq = MAX_SAFE_INTEGER as a
// placeholder, but #optimistic runs applyAndReseq (which reseqs every entry to a contiguous 0-based
// index) BEFORE it emits, so every emitted snapshot already carries a real seq and no subscriber
// ever observes the placeholder. The call site tested `e.rotationSeq === Number.MAX_SAFE_INTEGER`,
// which is therefore always false.
//
// Per the issue's explicit instruction: the guard is a UNIT TEST ON THE STORE (a row is reported
// pending between addSong() and the server ack, and not after), NOT an assertion of the literal
// MAX_SAFE_INTEGER comparison -- that comparison is the thing that is wrong.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { QueueStore } from './queue';
import type { ClientCommand } from '@encore/shared';

// deterministic id minting: addSong mints entryId THEN clientOpId (id0/id1, id2/id3, ...).
function makeStore() {
	const sent: ClientCommand[] = [];
	let n = 0;
	const store = new QueueStore({
		sendCommand: (c) => sent.push(c),
		singerId: 'me',
		mintId: () => `id${n++}`
	});
	return { store, sent };
}

test('a freshly-added row is reported pending (unconfirmedAddIds) and its seq is NOT the placeholder', () => {
	const { store } = makeStore();
	const id = store.addSong('m1'); // id0 entry, id1 opId

	// The row is pending between addSong() and the server ack -- this is the state QueueRow's
	// `adding…` marker and its {#if !pending} action gate were designed to read.
	expect(store.unconfirmedAddIds.has(id)).toBe(true);

	// And the reason the old condition was dead: the emitted entry does NOT carry the placeholder,
	// it already has a real contiguous seq. So a fix that keyed on the placeholder would mark NOTHING.
	expect(store.entries[0]!.rotationSeq).toBe(0);
	expect(store.entries[0]!.rotationSeq).not.toBe(Number.MAX_SAFE_INTEGER);
});

test('the pending mark clears once the server confirms the add (patch causedBy)', () => {
	const { store } = makeStore();
	const id = store.addSong('m1'); // id0 entry, id1 opId
	expect(store.unconfirmedAddIds.has(id)).toBe(true);

	store.onServerEvent({ type: 'queue:patch', patch: { rev: 1, ops: [], causedBy: 'id1' } });

	expect(store.unconfirmedAddIds.has(id)).toBe(false);
	expect(store.unconfirmedAddIds.size).toBe(0);
	// The row itself survives the ack -- only its pending status changed.
	expect(store.entries.map((e) => e.id)).toEqual([id]);
});

test('the pending mark clears when the server rejects the add', () => {
	const { store } = makeStore();
	const id = store.addSong('m1'); // id0 entry, id1 opId
	expect(store.unconfirmedAddIds.has(id)).toBe(true);

	store.onServerEvent({ type: 'op:reject', clientOpId: 'id1', reason: 'unknown media' });

	expect(store.unconfirmedAddIds.has(id)).toBe(false);
	expect(store.entries).toHaveLength(0); // rolled back
});

test('a pending MOVE or REMOVE does not mark any row as a newly-unconfirmed add', () => {
	const { store } = makeStore();
	store.addSong('m1'); // id0 entry, id1 opId
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 1, ops: [], causedBy: 'id1' } });
	store.addSong('m2'); // id2 entry, id3 opId
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 2, ops: [], causedBy: 'id3' } });
	expect(store.unconfirmedAddIds.size).toBe(0); // settled

	// A pending move is not an add -- it must not resurrect the "adding…" marker on a settled row.
	store.moveEntry('id0', 1); // id4 opId (move mints only the opId)
	expect(store.unconfirmedAddIds.size).toBe(0);

	// Same for a pending remove.
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 3, ops: [], causedBy: 'id4' } });
	store.removeEntry('id2'); // id5 opId
	expect(store.unconfirmedAddIds.size).toBe(0);
});

// Source-scan guards for the two call-site wirings the store test cannot exercise (they are Svelte
// markup, not store behaviour). These red on base: base passes the dead MAX_SAFE_INTEGER comparison
// and ProcessingCard has no pending prop at all.
const PAGE = readFileSync(new URL('../../routes/+page.svelte', import.meta.url), 'utf8');
const PROC = readFileSync(new URL('../components/ProcessingCard.svelte', import.meta.url), 'utf8');
const GALLERY = readFileSync(new URL('../../routes/components/+page.svelte', import.meta.url), 'utf8');

test('the +page.svelte call sites gate pending on the real pending set, not the placeholder seq', () => {
	// The dead comparison is gone entirely...
	expect(PAGE).not.toContain('rotationSeq === Number.MAX_SAFE_INTEGER');
	// ...and both QueueRow and ProcessingCard read the unconfirmed-add set.
	const wired = PAGE.match(/pending=\{unconfirmed\.has\(e\.id\)\}/g) ?? [];
	expect(wired.length).toBe(2);
});

test('+page.svelte declares the unconfirmed $state set and refreshes it on every store emit', () => {
	// The set the call sites read must exist as reactive state...
	expect(PAGE).toMatch(/let\s+unconfirmed\s*=\s*\$state<Set<string>>\(/);
	// ...and be re-read from the store inside the subscribe callback, or it never updates when an add
	// is acked/rejected. A bare `store.subscribe((e) => (entries = e))` (the base form) leaves it stale.
	expect(PAGE).toMatch(/unconfirmed\s*=\s*store\.unconfirmedAddIds/);
});

test('ProcessingCard accepts a pending prop so the "adding…" state survives the cooking case', () => {
	// The primary ✨ Sing flow produces a cooking entry, so ProcessingCard is what renders during an
	// add. On base it had no pending prop; the fix must give it one, default it, and wire the visuals.
	expect(PROC).toMatch(/pending\?:\s*boolean/); // interface field
	expect(PROC).toMatch(/pending\s*=\s*false,/); // destructuring default
	expect(PROC).toContain('class:pending'); // the dim class on the root
	// The remove/reorder cluster is hidden while unconfirmed.
	expect(PROC).toMatch(/\{#if\s+!pending\s*&&/);
});

test('ProcessingCard renders the "adding…" marker gated on pending, and styles it', () => {
	// The marker markup itself must be present and gated on `pending` -- an assertion that survived a
	// mention of the word in a comment would not bite reverting the markup, so require the span shape.
	expect(PROC).toMatch(/\{#if pending\}[\s\S]*?<span class="adding"[\s\S]*?adding…[\s\S]*?<\/span/);
	// And the two CSS rules that make the state visible: the card's warn-tinted surface and the
	// warn-tinted marker. This pinned `opacity: 0.55` until #735 -- what it pinned was the
	// declaration's PRESENCE, and the declaration turned out to be the defect: an ancestor opacity
	// flattened the whole card and dropped the stage line to 3.76:1 and the singer dot to 2.57:1. The
	// state signal is the SURFACE now, so this pins the surface. The legibility invariant itself lives
	// in contrast.test.ts (`no card root dims its own subtree with opacity`), which is what stops an
	// opacity coming back; this assertion only keeps the state from becoming invisible.
	expect(PROC).toMatch(/\.pending\s*\{[^}]*background:\s*var\(--warn-bg\)/);
	expect(PROC).toMatch(/\.pending\s*\{[^}]*border-color:\s*var\(--warn-line\)/);
	expect(PROC).toMatch(/\.adding\s*\{[^}]*color:\s*var\(--warn\)/);
});

/*
 * #735 §D: the component gallery must carry a PENDING ProcessingCard, and a source scan is the only
 * thing that can hold it. Both `pending` rules shipped in #304 unreadable (the cook readout at
 * 3.76:1, the singer dot at 2.57:1) specifically BECAUSE nothing ever rendered a pending cooking
 * card: the gallery's only pending fixture was a QueueRow, so the reviewer who found the defect had
 * to inject the class into the page by hand to measure it. A fixture's whole purpose is being looked
 * at, so its absence is invisible to every runtime assertion in the suite -- which is exactly what
 * prove_per_hunk.py reported (that hunk green when reverted, exit 20). This closes it the way §3
 * closes a pure deletion: assert against the real gallery source.
 */
test('the component gallery renders a pending ProcessingCard so the state is eyes-on', () => {
	const cards = [...GALLERY.matchAll(/<ProcessingCard\b([\s\S]*?)\/>/g)].map((m) => m[1]!);
	expect(cards.length).toBeGreaterThan(0); // non-vacuity: the gallery still has cooking cards at all
	// A bare `pending` attribute, not the word inside a title string or a comment.
	const pendingCards = cards.filter((attrs) => /(?:^|\s)pending(?=\s|$)/.test(attrs));
	expect(pendingCards.length).toBeGreaterThanOrEqual(1);
});
