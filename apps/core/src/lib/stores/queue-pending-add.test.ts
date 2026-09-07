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
	// And the two CSS rules that make the state visible: the card dim and the warn-tinted marker.
	expect(PROC).toMatch(/\.pending\s*\{[^}]*opacity:\s*0\.55/);
	expect(PROC).toMatch(/\.adding\s*\{[^}]*color:\s*var\(--warn\)/);
});
