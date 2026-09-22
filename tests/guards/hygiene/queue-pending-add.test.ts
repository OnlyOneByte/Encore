// Guard: the QueueRow/ProcessingCard "adding…" pending affordance must read the
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

	// The row is pending between addSong() and the server ack -- this is the state QueueRow's
	// `adding…` marker and its {#if !pending} action gate were designed to read.
	expect(store.pendingKindById.get(id)).toBe('add');

	// And the reason the old condition was dead: the emitted entry does NOT carry the placeholder,
	// it already has a real contiguous seq. So a fix that keyed on the placeholder would mark NOTHING.
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
	// The row itself survives the ack -- only its pending status changed.
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

	// THE GAP THIS CLOSES. The store used to expose adds only, and said so: "a pending move/remove does
	// not make an entry newly unconfirmed". So a reorder committed on a flaky socket looked IDENTICAL to
	// one that landed -- the row slid into its new slot with nothing saying the slide was still a guess.
	store.moveEntry('id0', 1); // id4 opId (move mints only the opId)
	expect(store.pendingKindById.get('id0')).toBe('move');
	// …and it is a MOVE, not an add: the marker's copy differs, and a row already in the queue must not
	// claim it is "adding".
	expect(store.pendingKindById.get('id0')).not.toBe('add');
	expect(store.pendingKindById.size).toBe(1);

	// The mark clears on the ack, within the same emit.
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 3, ops: [], causedBy: 'id4' } });
	expect(store.pendingKindById.size).toBe(0);

	// A pending REMOVE marks nothing: the row is gone from the list optimistically, so there is no row
	// left to mark -- its disclosure is the undo toast.
	store.removeEntry('id2'); // id5 opId
	expect(store.pendingKindById.size).toBe(0);
});

// Source-scan guards for the two call-site wirings the store test cannot exercise (they are Svelte
// markup, not store behaviour). These red on base: base passes the dead MAX_SAFE_INTEGER comparison
// and ProcessingCard has no pending prop at all.
//
// Named from the repo root rather than as `new URL('../../routes/…', import.meta.url)`. That spelling is
// the same self-anchoring defect as `join(import.meta.dir, '..')` wearing a different hat — it resolves
// against THIS file's address, so it silently re-pointed when the test left `src/lib/stores/` — and it is
// the worse of the two, because a `new URL` miss surfaces as a bare ENOENT from readFileSync rather than
// naming the guard whose subject went missing.
const PAGE = read('src/routes/+page.svelte');
const ROW = read('src/lib/components/QueueRow.svelte');
const PROC = read('src/lib/components/ProcessingCard.svelte');
const GALLERY = read('src/routes/components/+page.svelte');

test('the +page.svelte call sites gate pending on the real pending set, not the placeholder seq', () => {
	// The dead comparison is gone entirely...
	expect(PAGE).not.toContain('rotationSeq === Number.MAX_SAFE_INTEGER');
	// ...and both QueueRow and ProcessingCard read the store's pending KIND for that row. `?? null`
	// matters: `undefined` would leave the prop at its own default rather than stating "confirmed".
	const wired = PAGE.match(/pending=\{pendingKind\.get\(e\.id\) \?\? null\}/g) ?? [];
	expect(wired.length).toBe(2);
});

test('+page.svelte declares the unconfirmed $state set, and BOTH hops refresh it on every store emit', () => {
	// The map the call sites read must exist as reactive state...
	expect(PAGE).toMatch(/let\s+pendingKind\s*=\s*\$state<Map<string, 'add' \| 'move'>>\(/);
	// ...and be refreshed on every emit, or it never updates when an op is acked/rejected. A bare
	// `store.subscribe((e) => (entries = e))` (the base form) leaves it stale.
	//
	// THE CHAIN IS TWO HOPS SINCE THE ROOM-LINK HOIST, and a break in either one is the same stale-marker
	// defect, so both are pinned here rather than only the end the call sites can see. The QueueStore is
	// owned by the link now (the socket is app-wide, not the route's), so: the link re-reads the kind map
	// inside the store's subscribe, and the page mirrors the link's copy inside the link's subscribe.
	// Pinning only the page's hop would let the link stop refreshing and this guard would stay green
	// while every row went back to lying about whether its move had landed.
	const LINK = read('src/lib/stores/room.ts');
	expect(LINK).toMatch(/this\.pendingKind\s*=\s*this\.queue!\.pendingKindById/);
	expect(PAGE).toMatch(/pendingKind\s*=\s*room\.pendingKind/);
});

test('QueueRow takes the pending KIND, defaults it, and derives one label from it', () => {
	// The type and the default are TYPE-level and default-level facts: reverting either changes no
	// runtime behaviour the suite can observe (a boolean `true` still renders the add marker), so they
	// are asserted here as the syntax claims they are. The RENDERED difference between the two kinds is
	// measured against the real DOM in lib/components/phone-home.test.ts.
	expect(ROW).toMatch(/pending\?:\s*'add' \| 'move' \| null/); // interface field
	expect(ROW).toMatch(/pending\s*=\s*null,/); // destructuring default — absent means CONFIRMED
	// ONE expression decides the word, so the two states cannot drift back into saying the same thing.
	expect(ROW).toMatch(/pendingLabel\s*=\s*\$derived\(pending === 'move' \? 'moving…' : 'adding…'\)/);
	// …and the marker renders that expression rather than a hardcoded word.
	expect(ROW).toMatch(/<span class="adding">\{pendingLabel\}<\/span>/);
	expect(ROW).not.toMatch(/<span class="adding">adding…<\/span>/);
});

test('ProcessingCard accepts a pending prop so the "adding…" state survives the processing case', () => {
	// The primary ✨ Sing flow produces a processing entry, so ProcessingCard is what renders during an
	// add. On base it had no pending prop; the fix must give it one, default it, and wire the visuals.
	// Since the prop is the op KIND rather than a boolean, so a pending reorder of a processing entry
	// does not announce that it is "adding".
	expect(PROC).toMatch(/pending\?:\s*'add' \| 'move' \| null/); // interface field
	expect(PROC).toMatch(/pending\s*=\s*null,/); // destructuring default
	expect(PROC).toContain('class:pending'); // the dim class on the root
	// The remove/reorder cluster is hidden while unconfirmed.
	expect(PROC).toMatch(/\{#if\s+!pending\s*&&/);
});

test('ProcessingCard renders the "adding…" marker gated on pending, and styles it', () => {
	// The marker markup itself must be present and gated on `pending` -- an assertion that survived a
	// mention of the word in a comment would not bite reverting the markup, so require the span shape.
	expect(PROC).toMatch(/\{#if pending\}[\s\S]*?<span class="adding"[\s\S]*?\{pendingLabel\}[\s\S]*?<\/span/);
	// …and the label itself distinguishes the two kinds. One expression, so they cannot drift back into
	// saying the same thing.
	expect(PROC).toMatch(/pendingLabel\s*=\s*\$derived\(pending === 'move' \? 'moving…' : 'adding…'\)/);
	// And the two CSS rules that make the state visible: the card's warn-tinted surface and the
	// warn-tinted marker. This pinned `opacity: 0.55` until -- what it pinned was the
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
 * §D: the component gallery must carry a PENDING ProcessingCard, and a source scan is the only
 * thing that can hold it. Both `pending` rules shipped in unreadable (the process readout at
 * 3.76:1, the singer dot at 2.57:1) specifically BECAUSE nothing ever rendered a pending processing
 * card: the gallery's only pending fixture was a QueueRow, so the reviewer who found the defect had
 * to inject the class into the page by hand to measure it. A fixture's whole purpose is being looked
 * at, so its absence is invisible to every runtime assertion in the suite -- which is exactly what
 * prove_per_hunk.py reported (that hunk green when reverted, exit 20). This closes it the way §3
 * closes a pure deletion: assert against the real gallery source.
 */
test('the component gallery renders a pending ProcessingCard so the state is eyes-on', () => {
	const cards = [...GALLERY.matchAll(/<ProcessingCard\b([\s\S]*?)\/>/g)].map((m) => m[1]!);
	expect(cards.length).toBeGreaterThan(0); // non-vacuity: the gallery still has processing cards at all
	// A real `pending` ATTRIBUTE, not the word inside a title string or a comment. Since it carries
	// the op kind, so `pending="add"` is the shape; a bare `pending` would now type as `true`.
	const pendingCards = cards.filter((attrs) => /(?:^|\s)pending="(add|move)"(?=\s|$)/.test(attrs));
	expect(pendingCards.length).toBeGreaterThanOrEqual(1);
});

test('the component gallery renders a pending REORDER row, so the new state is eyes-on', () => {
	// Same reasoning as the fixture above, which had to add after both `pending` rules shipped
	// unreadable BECAUSE nothing ever rendered that state: a state with no fixture is judged by nobody.
	// `moving…` vs `adding…` is a one-word difference on an identical surface, which is exactly the kind
	// of thing that regresses silently, so the gallery carries both and they sit next to each other.
	const rows = [...GALLERY.matchAll(/<QueueRow\b([\s\S]*?)\/>/g)].map((m) => m[1]!);
	expect(rows.length).toBeGreaterThan(0); // non-vacuity
	expect(rows.filter((attrs) => /(?:^|\s)pending="move"(?=\s|$)/.test(attrs)).length).toBeGreaterThanOrEqual(1);
	expect(rows.filter((attrs) => /(?:^|\s)pending="add"(?=\s|$)/.test(attrs)).length).toBeGreaterThanOrEqual(1);
});

test('no two fixtures in the gallery QueueRow section claim the same queue position', () => {
	// Adding the pending-move fixture took seq 6, which the long-name fixture already used. Two rows in
	// ONE list showing the same numbered bubble reads as a bug in the app rather than in the gallery,
	// and a fixture's whole purpose is being looked at. Scoped to this section: later sections
	// legitimately restart their numbering, so a file-wide uniqueness claim would be false.
	const start = GALLERY.indexOf('<h2 class="section">QueueRow</h2>');
	expect(start).toBeGreaterThan(0);
	const section = GALLERY.slice(start, GALLERY.indexOf('<h2 class="section">', start + 1));
	const seqs = [...section.matchAll(/seq=\{(\d+)\}/g)].map((m) => Number(m[1]));
	expect(seqs.length).toBeGreaterThan(1); // non-vacuity
	expect(new Set(seqs).size).toBe(seqs.length);
});
