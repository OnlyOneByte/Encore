// XR-PH-20 / XR-PH-03 / XR-PH-06 (issue #836) — the parts of the reorder mode whose acceptance is a
// statement about the SOURCE, scanned here because they are claims about what the template can never
// do rather than about a value it computes.
//
// XR-PH-20 is a WCAG 2.5.7 conformance row, and its stated check is exactly this: "Source scan that
// the mode's row template includes the button pair unconditionally". A behavioural test cannot make
// that claim — it can only show the buttons were there in the states it happened to drive, while the
// requirement is that no state removes them.
//
// Every test asserts a SENTINEL first (that it is reading the file and the thing it judges is present),
// so a rename or a moved block reds the guard instead of silently passing over an empty scan (#830).
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROW = join(import.meta.dir, 'QueueRow.svelte');
const PAGE = join(import.meta.dir, '..', '..', 'routes', '+page.svelte');
const row = () => readFileSync(ROW, 'utf8');
const page = () => readFileSync(PAGE, 'utf8');

/** Blank both comment forms: this file's own rationale names the very strings it forbids. */
function stripComments(src: string): string {
	return src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
/** The markup region only — a `<style>` body is not a template. */
function markup(src: string): string {
	return stripComments(src).replace(/<style[\s\S]*?<\/style>/gi, '');
}

// ── XR-PH-20 · the single-pointer alternative stays, and stays reachable ──────────────────────────

test('XR-PH-20 · the row template carries BOTH move buttons', () => {
	const m = markup(row());
	expect(m).toContain('aria-label="move up"');
	expect(m).toContain('aria-label="move down"');
});

test('XR-PH-20 · the grip is a SIBLING of the button pair, never a wrapper or an {:else} against it', () => {
	const m = markup(row());
	// Sentinel: both blocks are present, so the ordering claim below is about real code.
	const gripAt = m.indexOf('{#if grip}');
	const upAt = m.indexOf('aria-label="move up"');
	const downAt = m.indexOf('aria-label="move down"');
	expect(gripAt).toBeGreaterThan(-1);
	expect(upAt).toBeGreaterThan(-1);
	expect(downAt).toBeGreaterThan(-1);

	// The button pair sits OUTSIDE the grip's block. If the grip ever wrapped them, both buttons would
	// fall between `{#if grip}` and its `{/if}` — the arrangement that makes the alternative
	// conditional on the drag affordance and falsifies the requirement.
	const gripBlockEnd = m.indexOf('{/if}', gripAt);
	expect(gripBlockEnd).toBeGreaterThan(gripAt);
	expect(upAt < gripAt || upAt > gripBlockEnd).toBe(true);
	expect(downAt < gripAt || downAt > gripBlockEnd).toBe(true);
	// And the grip is not the negative branch of the pair's own condition.
	expect(m).not.toContain('{:else}');
});

test('XR-PH-20 · no mode state gates the move buttons', () => {
	// The buttons' only condition is the pre-existing `reorderable` (and the pre-existing `!pending`).
	// The mode's own names must not appear in a condition around them — that is what "never hidden or
	// disabled by the mode itself" forbids.
	const m = markup(row());
	const upAt = m.indexOf('aria-label="move up"');
	const head = m.slice(0, upAt);
	// Walk the conditions still OPEN at the button pair by counting block opens/closes.
	const opens = [...head.matchAll(/\{#if\s+([^}]*)\}/g)];
	const closes = (head.match(/\{\/if\}/g) ?? []).length;
	const openConds = opens.slice(closes).map((mm) => mm[1]!.trim());
	expect(openConds.length).toBeGreaterThan(0); // sentinel: the pair really is inside some condition
	// WHOLE-WORD, not substring: `reorderable` is the pre-existing gate this requirement explicitly
	// keeps ("Existing gate: QueueRow.svelte's reorderable / canUp / canDown props"), and it contains
	// the string "reorder". What is banned is the MODE's own state reaching these buttons.
	const banned = /\b(grip|moving|dimmed|dragY|reorderOpen|reorderMode)\b/;
	for (const c of openConds) {
		expect(banned.test(c)).toBe(false);
	}
	// …and the condition that IS there is the pre-existing pair, so this is not passing on a template
	// that lost its gate altogether.
	expect(openConds.some((c) => /\breorderable\b/.test(c))).toBe(true);
});

test('XR-PH-20 · the page keeps the buttons wired on the row being dragged', () => {
	// `rowFrozen` is the mode's only suppression, and it is scoped to OTHER guests' rows — so the
	// dragged row (which is always the actor's own) keeps `reorderable` and both handlers.
	const src = stripComments(page());
	expect(src).toContain('function rowFrozen(');
	expect(/function rowFrozen\([^)]*\)[^{]*\{\s*return reorderOpen && e\.singerId !== me\?\.id;/.test(src)).toBe(true);
	expect(src).toContain('onup={()');
	expect(src).toContain('ondown={()');
	// Applied on BOTH row kinds — ProcessingCard (a cooking pick) and QueueRow (a ready pick). Counted
	// rather than matched once, for the same reason global-reorder-client-638.test.ts:32 counts: losing
	// it on either row leaves the mode offering a cross-singer control on a row it has just dimmed.
	expect((src.match(/reorderable=\{!rowFrozen\(e\) &&/g) ?? []).length).toBe(2);
});

// ── XR-PH-03 · de-emphasis never uses subtree opacity ─────────────────────────────────────────────

test('XR-PH-03 · the dimmed row is de-emphasised with a surface token, not opacity', () => {
	const src = row();
	const rule = /\.dimmed\s*\{([^}]*)\}/.exec(stripComments(src));
	expect(rule).not.toBeNull(); // sentinel: the rule exists to be judged
	const body = rule![1]!;
	expect(/background:\s*var\(--[\w-]+\)/.test(body)).toBe(true);
	expect(/border-color:\s*var\(--[\w-]+\)/.test(body)).toBe(true);
	// The defect this row exists to prevent, and the one `.pending` already records on this same row.
	expect(/(^|[;\s])opacity\s*:/.test(body)).toBe(false);
});

test('XR-PH-03 · the dimmed row is not hidden from assistive tech', () => {
	// The dimmed rows stay INFORMATIONAL during the mode — they are who you are being ordered around —
	// so the mode must not reach for `inert` or `aria-hidden` on a row to make it non-interactive. It
	// drops the row's controls instead (`rowFrozen`).
	const m = markup(row());
	expect(m).not.toContain('inert');
	expect(m).not.toMatch(/aria-hidden=\{?["']?true/);
});

// ── XR-PH-17 · cursor: grab exists only where a reorder is real ───────────────────────────────────

// `grab` must not match `grabbing`: the grip legitimately declares `cursor: grabbing` on :active, and
// a prefix match reported that as a second offender. Anchored on the value's own terminator.
const GRAB_RULE = /([^{}]+)\{([^}]*cursor:\s*grab\s*(?=[;}])[^}]*)\}/g;

test('XR-PH-17 · cursor:grab is declared on the grip button and on no row', () => {
	const src = stripComments(row());
	// Sentinel: the declaration exists at all, so an empty scan cannot pass this.
	expect(/cursor:\s*grab\s*[;}]/.test(src)).toBe(true);
	const grabRules = [...src.matchAll(GRAB_RULE)].map((m) => m[1]!.trim());
	expect(grabRules).toEqual(['.grip']); // exactly one, and it is the button
});

test('XR-PH-17 · no other component reintroduces a row-level grab cursor', () => {
	// The removed affordance came back once already. Scanned across the two files this issue touches.
	for (const src of [stripComments(row()), stripComments(page())]) {
		for (const m of src.matchAll(GRAB_RULE)) {
			expect(m[1]!.trim()).toBe('.grip');
		}
	}
});

test('XR-PH-17 · the grip binding goes through the predicate, never a literal', () => {
	// Found by mutation: `grip={true}` on every row left the whole suite green — and that is exactly the
	// recorded regression (a grip on another guest's song, where it is the sole affordance). The
	// predicate's own tests cannot see this: they prove `gripVisible` answers correctly, not that the
	// template asks it.
	const m = markup(page());
	expect(m).toContain('grip={gripFor(e)}');
	expect(/grip=\{(true|false|!?\w+\.\w+)\}/.test(m)).toBe(false);

	// …and `gripFor` really forwards the row's own singer identity, so `mine` cannot be hard-true.
	const src = stripComments(page());
	const fn = /function gripFor\([\s\S]*?\n\t\}/.exec(src);
	expect(fn).not.toBeNull(); // sentinel
	const body = fn![0]!;
	expect(body).toContain('gripVisible(');
	expect(body).toContain('mine: e.singerId === me?.id');
	expect(body).toContain('ownQueuedCount: myPicks.length');
	expect(body).toContain('reorderMeaningful: canReorder');
});

// ── the four invariants the DRIVEN run found, pinned cheaply ──────────────────────────────────────
//
// Each of these was a real defect that every test in this repo was green on, because each is about
// element identity or hit-testing rather than about a value. Each was found by DRIVING the mode in a
// real browser with a trusted pointer, and none of them is visible to a value-level test — so these
// scans are what keeps them from coming back. They are a floor, not a proof: the rendered rung for
// XR-PH-18's target count and XR-PH-19's focus return is still owed (XR-PH-21).

test('#836 driven-find 1 · the drag listens on window, not on the grip element', () => {
	// Opening the mode inserts the drop slots, so Svelte re-renders the rows and the pressed grip becomes
	// a DETACHED node. Listeners bound to it delivered nothing: the drag produced no move and the release
	// never arrived, so a real drag moved no row and never closed the mode.
	const src = stripComments(page());
	const fn = /function onGripPointerDown\([\s\S]*?\n\t\}/.exec(src);
	expect(fn).not.toBeNull(); // sentinel
	const body = fn![0]!;
	for (const ev of ['pointermove', 'pointerup', 'pointercancel']) {
		expect(body).toContain(`window.addEventListener('${ev}'`);
		expect(body).toContain(`window.removeEventListener('${ev}'`);
		expect(body.includes(`grip.addEventListener('${ev}'`)).toBe(false);
	}
	// And no pointer capture on that node either — a captured pointer on a detached element is the same
	// defect wearing a different hat.
	expect(/setPointerCapture/.test(body)).toBe(false);
});

test('#836 driven-find 2 · the dragged row is transparent to hit-testing', () => {
	// The row is translated to sit under the finger with `z-index: 2`, so it was the topmost element at
	// the pointer and `elementFromPoint` returned IT instead of the drop slot beneath — a drag released
	// squarely on a legal target committed nothing.
	const rule = /\.moving\s*\{([^}]*)\}/.exec(stripComments(row()));
	expect(rule).not.toBeNull(); // sentinel
	expect(/pointer-events:\s*none/.test(rule![1]!)).toBe(true);
});

test('#836 driven-find 3 · the drag-active state is separate from the mode subject', () => {
	// `.moving` carries `pointer-events: none`, so if it applied for the life of the mode the row's own
	// grip stayed untouchable after the first tap and no later drag could start. The prop must therefore
	// read BOTH the subject and the active-drag flag.
	const src = stripComments(page());
	expect(src).toContain('let dragging = $state(false)');
	expect(src).toContain('moving={movingId === e.id && dragging}');
	expect(src).toContain('dragY={movingId === e.id && dragging ? dragY : 0}');
	// The flag must be cleared on the exit path too, or a committed drag leaves the next row inert.
	const exit = /function exitReorder\([\s\S]*?\n\t\}/.exec(src);
	expect(exit![0]).toContain('dragging = false');
});

test('#836 driven-find 4 · a tap opens the mode and leaves it open', () => {
	// Treating every release as a drop made a tap open and immediately close the mode: `hoverSlot` starts
	// at the row's own index, so the release resolved to "move to where you already are".
	const src = stripComments(page());
	expect(src).toContain('const TAP_SLOP_PX');
	const fn = /function onGripPointerDown\([\s\S]*?\n\t\}/.exec(src);
	expect(fn![0]).toContain('travelled <= TAP_SLOP_PX');
});

test('#836 driven-find 5 · focus return is re-found by attribute, not by a held element', () => {
	// The grip the guest pressed is a detached node by the time the mode closes, so focusing the captured
	// reference put focus nowhere — `activeElement` was `<body>` after Escape.
	const src = stripComments(page());
	expect(src).toContain('gripId={e.id}');
	expect(markup(row())).toContain('data-grip={gripId}');
	const exit = /function exitReorder\([\s\S]*?\n\t\}/.exec(src);
	expect(exit![0]).toContain('data-grip=');
	expect(exit![0]).toContain('tick().then(');
});

test('#836 · the cooking row dims too, with a surface and not opacity', () => {
	// Another guest's cooking song is one of the rows the mode has to de-emphasise — found by driving the
	// mode, where the only non-mine row on screen was a ProcessingCard and stayed at full weight.
	const src = stripComments(readFileSync(join(import.meta.dir, 'ProcessingCard.svelte'), 'utf8'));
	const rule = /\.dimmed\s*\{([^}]*)\}/.exec(src);
	expect(rule).not.toBeNull(); // sentinel
	const body = rule![1]!;
	expect(/background:\s*var\(--[\w-]+\)/.test(body)).toBe(true);
	expect(/(^|[;\s])opacity\s*:/.test(body)).toBe(false);
	// …and it is actually bound at the call site, on BOTH row kinds.
	expect((stripComments(page()).match(/dimmed=\{reorderOpen && !isMine\}/g) ?? []).length).toBe(2);
});

// ── XR-PH-06 · the mode's motion is CSS-driven ────────────────────────────────────────────────────

test('XR-PH-06 · the drag is a CSS transform reading a var, with nothing interpolated over time', () => {
	const src = stripComments(row());
	const moving = /\.moving\s*\{([^}]*)\}/.exec(src);
	expect(moving).not.toBeNull(); // sentinel
	const body = moving![1]!;
	// The position comes from a custom property the pointer writes, through `transform` — a
	// GPU-composited property, which is the only kind `motion.test.ts` permits animating at all.
	expect(/transform:\s*translateY\(var\(--drag-y/.test(body)).toBe(true);
	// No duration on the moving row: a 1:1 response to the pointer is not an animation, and there is
	// therefore nothing for `prefers-reduced-motion` to have to zero out.
	expect(/transition/.test(body)).toBe(false);
	expect(/animation/.test(body)).toBe(false);
});

test('XR-PH-06 · no drag library is pulled in for the mode', () => {
	// The requirement names `svelte-dnd-action` as the hazard: its motion is written as inline styles
	// by JS, which `motion.test.ts` cannot see by construction. The mode is built on Pointer Events +
	// a CSS var instead, so the enforcement gap is never opened.
	const src = page() + row();
	expect(src).not.toContain('svelte-dnd-action');
	expect(src).not.toContain('dndzone');
	const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf8'));
	const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
	expect(Object.keys(deps)).not.toContain('svelte-dnd-action');
});

// ── XR-PH-18 · the slots are drawn, and a drop cannot be approximated ────────────────────────────

test('XR-PH-18 · each drop target is a real button carrying its ordinal as an accessible name', () => {
	const m = markup(page());
	const slotAt = m.indexOf('class="dropslot"');
	expect(slotAt).toBeGreaterThan(-1); // sentinel
	const block = m.slice(slotAt - 200, slotAt + 400);
	expect(block).toContain('<button');
	expect(block).toContain('aria-label={slot.label}');
	expect(block).toContain('data-slot={slot.index}');
	// Committing goes through the same exit the pointer release uses, so the keyboard and pointer paths
	// cannot commit different indices.
	expect(block).toContain('exitReorder(slot.index)');
});

test('XR-PH-18 · the slots render only while the mode is open, and only on the guest\u2019s own rows', () => {
	const m = markup(page());
	expect(m).toContain('{#if reorderOpen && isMine && ownIdx >= 0 && mySlots[ownIdx]}');
});

test('XR-PH-18 · the PAGE derives its slots from the guest\u2019s own picks, not the visible list', () => {
	// Found by mutation: pointing this derivation at `queued.length` left every other assertion in this
	// suite green, because they all test `ownSlots` in isolation. `ownSlots` cannot defend the claim on
	// its own — it is not given the list length, so the only place the wrong collection can be supplied
	// is here. That makes this scan the sole guard on XR-PH-18's central sentence, and the count claim
	// vacuous without it.
	const src = stripComments(page());
	const decl = /const mySlots = \$derived\(([^)]*\)?[^;]*)\);/.exec(src);
	expect(decl).not.toBeNull(); // sentinel: the derivation exists to be judged
	const expr = decl![1]!;
	expect(expr).toContain('myPicks.length');
	// The two collections it must never read: the whole queued list, and the rendered rows.
	expect(/\bqueued\b/.test(expr)).toBe(false);
	expect(/\bentries\b/.test(expr)).toBe(false);
});

test('XR-PH-18 · the dimming is applied to other guests\u2019 rows only', () => {
	// Mirror of the slot guard: the visual half of "only the guest's own positions accept a drop" is a
	// binding on this page, so an inverted or unscoped condition here is invisible to a unit test.
	const m = markup(page());
	expect(m).toContain('dimmed={reorderOpen && !isMine}');
});

test('XR-PH-18 · every release is routed through dropTarget rather than passed to moveEntry raw', () => {
	// `reorderWithinSinger` CLAMPS an out-of-range toIdx, so a raw pass-through would commit a position
	// the guest did not choose. The guard is that the only `moveEntry` in the mode's exit reads the
	// value `dropTarget` returned.
	const src = stripComments(page());
	const exit = /function exitReorder\([\s\S]*?\n\t\}/.exec(src);
	expect(exit).not.toBeNull(); // sentinel
	const body = exit![0]!;
	expect(body).toContain('const target = dropTarget(');
	expect(/store\?\.moveEntry\(id, target\)/.test(body)).toBe(true);
	expect(/target !== null/.test(body)).toBe(true);
});
