// The QueueRow/ProcessingCard "adding…" affordance must read the store's REAL pending map. `addSong()` stamps
// `rotationSeq = Number.MAX_SAFE_INTEGER` as a placeholder, but `#optimistic` runs `applyAndReseq` before it
// emits, so every snapshot already carries a real contiguous seq and the call site's
// `e.rotationSeq === Number.MAX_SAFE_INTEGER` was always false. Pinned as STORE behaviour (pending between
// addSong() and the ack, and not after), never as that comparison, because the comparison is what is wrong.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { QueueStore } from '$lib/stores/queue';
import type { ClientCommand } from '$lib/contract';

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

test('a freshly-added row is reported pending (pendingKindById) and its seq is NOT the placeholder', () => {
	const { store } = makeStore();
	const id = store.addSong('m1'); // id0 entry, id1 opId

	// The state QueueRow's `adding…` marker and its `{#if !pending}` action gate were designed to read.
	expect(store.pendingKindById.get(id)).toBe('add');

	// And why the old condition was dead: the emitted entry already has a real seq, so a fix keyed on the
	// placeholder would mark NOTHING.
	expect(store.entries[0]!.rotationSeq).toBe(0);
	expect(store.entries[0]!.rotationSeq).not.toBe(Number.MAX_SAFE_INTEGER);
});

test('the pending mark clears once the server confirms the add (patch causedBy)', () => {
	const { store } = makeStore();
	const id = store.addSong('m1'); // id0 entry, id1 opId
	expect(store.pendingKindById.get(id)).toBe('add');

	store.onServerEvent({ type: 'queue:patch', patch: { rev: 1, ops: [], causedBy: 'id1' } });

	expect(store.pendingKindById.has(id)).toBe(false);
	expect(store.pendingKindById.size).toBe(0);
	expect(store.entries.map((e) => e.id)).toEqual([id]);
});

test('the pending mark clears when the server rejects the add', () => {
	const { store } = makeStore();
	const id = store.addSong('m1'); // id0 entry, id1 opId
	expect(store.pendingKindById.get(id)).toBe('add');

	store.onServerEvent({ type: 'op:reject', clientOpId: 'id1', reason: 'unknown media' });

	expect(store.pendingKindById.has(id)).toBe(false);
	expect(store.entries).toHaveLength(0); // rolled back
});

test('a pending REORDER marks its row as move — not as an add, and not as nothing', () => {
	const { store } = makeStore();
	store.addSong('m1'); // id0 entry, id1 opId
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 1, ops: [], causedBy: 'id1' } });
	store.addSong('m2'); // id2 entry, id3 opId
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 2, ops: [], causedBy: 'id3' } });
	expect(store.pendingKindById.size).toBe(0); // settled

	// THE GAP THIS CLOSES. The store used to expose adds only, so a reorder committed on a flaky socket looked
	// IDENTICAL to one that landed — the row slid into its new slot with nothing saying the slide was a guess.
	store.moveEntry('id0', 1); // id4 opId (move mints only the opId)
	expect(store.pendingKindById.get('id0')).toBe('move');
	// …and it is a MOVE, not an add: the copy differs, and a queued row must not claim it is "adding".
	expect(store.pendingKindById.get('id0')).not.toBe('add');
	expect(store.pendingKindById.size).toBe(1);

	store.onServerEvent({ type: 'queue:patch', patch: { rev: 3, ops: [], causedBy: 'id4' } });
	expect(store.pendingKindById.size).toBe(0);

	// A pending REMOVE marks nothing: the row is gone optimistically, so its disclosure is the undo toast.
	store.removeEntry('id2'); // id5 opId
	expect(store.pendingKindById.size).toBe(0);
});

// Source scans for the two call-site wirings the store test cannot exercise, being markup rather than store.
const PAGE = read('src/routes/+page.svelte');
const ROW = read('src/lib/components/QueueRow.svelte');
const PROC = read('src/lib/components/ProcessingCard.svelte');
const GALLERY = read('src/routes/components/+page.svelte');

test('the +page.svelte call sites gate pending on the real pending set, not the placeholder seq', () => {
	expect(PAGE).not.toContain('rotationSeq === Number.MAX_SAFE_INTEGER');
	// …and both rows read the store's pending KIND. `?? null` matters: `undefined` would leave the prop at its
	// own default rather than stating "confirmed".
	const wired = PAGE.match(/pending=\{pendingKind\.get\(e\.id\) \?\? null\}/g) ?? [];
	expect(wired.length).toBe(2);
});

test('+page.svelte declares the unconfirmed $state set, and BOTH hops refresh it on every store emit', () => {
	// The map the call sites read must exist as reactive state...
	expect(PAGE).toMatch(/let\s+pendingKind\s*=\s*\$state<Map<string, 'add' \| 'move'>>\(/);
	// …and be refreshed on every emit, or it never updates when an op is acked or rejected. THE CHAIN IS TWO HOPS
	// since the room link owns the QueueStore: the link re-reads the kind map inside the store's subscribe, and
	// the page mirrors the link's copy inside the link's subscribe. A break in either is the same stale marker.
	const LINK = read('src/lib/stores/room.ts');
	expect(LINK).toMatch(/this\.pendingKind\s*=\s*this\.queue!\.pendingKindById/);
	expect(PAGE).toMatch(/pendingKind\s*=\s*room\.pendingKind/);
});

test('QueueRow takes the pending KIND, defaults it, and derives one label from it', () => {
	// The type and the default are TYPE-level facts: reverting either changes no runtime behaviour the suite can
	// observe. The RENDERED difference between the kinds is measured in lib/components/phone-home.test.ts.
	expect(ROW).toMatch(/pending\?:\s*'add' \| 'move' \| null/); // interface field
	expect(ROW).toMatch(/pending\s*=\s*null,/); // destructuring default — absent means CONFIRMED
	// ONE expression decides the word, so the two states cannot drift back into saying the same thing.
	expect(ROW).toMatch(/pendingLabel\s*=\s*\$derived\(pending === 'move' \? 'moving…' : 'adding…'\)/);
	// …and the marker renders that expression rather than a hardcoded word.
	expect(ROW).toMatch(/<span class="adding">\{pendingLabel\}<\/span>/);
	expect(ROW).not.toMatch(/<span class="adding">adding…<\/span>/);
});

test('ProcessingCard accepts a pending prop so the "adding…" state survives the processing case', () => {
	// The primary ✨ Sing flow produces a processing entry, so ProcessingCard is what renders during an add. The
	// prop is the op KIND, so a pending reorder of a processing entry does not announce that it is "adding".
	expect(PROC).toMatch(/pending\?:\s*'add' \| 'move' \| null/); // interface field
	expect(PROC).toMatch(/pending\s*=\s*null,/); // destructuring default
	expect(PROC).toContain('class:pending'); // the dim class on the root
	expect(PROC).toMatch(/\{#if\s+!pending\s*&&/);
});

test('ProcessingCard renders the "adding…" marker gated on pending, and styles it', () => {
	// Require the span shape: an assertion a mention in a comment could satisfy would not bite reverting markup.
	expect(PROC).toMatch(/\{#if pending\}[\s\S]*?<span class="adding"[\s\S]*?\{pendingLabel\}[\s\S]*?<\/span/);
	expect(PROC).toMatch(/pendingLabel\s*=\s*\$derived\(pending === 'move' \? 'moving…' : 'adding…'\)/);
	// The two rules that make the state visible. This pinned `opacity: 0.55` until the declaration turned out to
	// BE the defect: an ancestor opacity flattened the card and dropped the stage line to 3.76:1 and the singer
	// dot to 2.57:1. The signal is the SURFACE now; `contrast.test.ts` owns the legibility invariant.
	expect(PROC).toMatch(/\.pending\s*\{[^}]*background:\s*var\(--warn-bg\)/);
	expect(PROC).toMatch(/\.pending\s*\{[^}]*border-color:\s*var\(--warn-line\)/);
	expect(PROC).toMatch(/\.adding\s*\{[^}]*color:\s*var\(--warn\)/);
});

/*
 * The gallery must carry a PENDING ProcessingCard, and only a source scan can hold it. Both `pending` rules
 * shipped unreadable specifically BECAUSE nothing ever rendered a pending processing card — the gallery's only
 * pending fixture was a QueueRow, so the defect had to be found by injecting the class by hand. A fixture's
 * whole purpose is being looked at, so its absence is invisible to every runtime assertion in the suite.
 */
test('the component gallery renders a pending ProcessingCard so the state is eyes-on', () => {
	const cards = [...GALLERY.matchAll(/<ProcessingCard\b([\s\S]*?)\/>/g)].map((m) => m[1]!);
	expect(cards.length).toBeGreaterThan(0); // non-vacuity: the gallery still has processing cards at all
	// A real `pending` ATTRIBUTE carrying the op kind, not the word inside a title string or a comment.
	const pendingCards = cards.filter((attrs) => /(?:^|\s)pending="(add|move)"(?=\s|$)/.test(attrs));
	expect(pendingCards.length).toBeGreaterThanOrEqual(1);
});

test('the component gallery renders a pending REORDER row, so the new state is eyes-on', () => {
	// Same reasoning as the fixture above: `moving…` vs `adding…` is a one-word difference on an identical
	// surface, so the gallery carries both and they sit next to each other.
	const rows = [...GALLERY.matchAll(/<QueueRow\b([\s\S]*?)\/>/g)].map((m) => m[1]!);
	expect(rows.length).toBeGreaterThan(0); // non-vacuity
	expect(rows.filter((attrs) => /(?:^|\s)pending="move"(?=\s|$)/.test(attrs)).length).toBeGreaterThanOrEqual(1);
	expect(rows.filter((attrs) => /(?:^|\s)pending="add"(?=\s|$)/.test(attrs)).length).toBeGreaterThanOrEqual(1);
});

test('no two fixtures in the gallery QueueRow section claim the same queue position', () => {
	// Two rows in ONE list showing the same numbered bubble reads as an app bug. Scoped to this section, because
	// later sections legitimately restart their numbering.
	const start = GALLERY.indexOf('<h2 class="section">QueueRow</h2>');
	expect(start).toBeGreaterThan(0);
	const section = GALLERY.slice(start, GALLERY.indexOf('<h2 class="section">', start + 1));
	const seqs = [...section.matchAll(/seq=\{(\d+)\}/g)].map((m) => Number(m[1]));
	expect(seqs.length).toBeGreaterThan(1); // non-vacuity
	expect(new Set(seqs).size).toBe(seqs.length);
});
