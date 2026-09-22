// / / — the parts of reordering whose acceptance is a statement about the
// SOURCE, scanned here because they are claims about what the template can never do rather than about a
// value it computes.
//
// ── THE MODE BECAME A LIVE SORT (2026-09-21), AND THESE ARMS FOLLOWED ────────────────────────────
//
// Half this file used to pin a MODE: a press opened it, the page drew one labelled `.dropslot` per queued
// position, a `.reorder-bar` offered Done and Cancel, and each row carried a `move up` / `move down` pair as
// the non-drag path. All of that is deleted — see the header of `$lib/reorder-mode` for why (the op widened
// to a global index, so "draw the legal positions" became "draw one per row", and four controls per row plus
// a bar plus a target between every pair of rows was reported on sight).
//
// IS STILL A WCAG 2.5.7 CONFORMANCE ROW AND IS STILL SCANNED HERE. Its check reads "source scan
// that the mode's row template includes the button pair unconditionally", and the MECHANISM it named is
// gone — so these arms assert the successor at the same strength: the grip is a real button, it carries
// `aria-keyshortcuts`, its keydown routes Arrow Up/Down to the page, and the page commits them through
// `keyboardMoveTarget`. A behavioural test could only show the path worked in the states it drove; the
// requirement is that no state removes it.
//
// Every test asserts a SENTINEL first (that it is reading the file and the thing it judges is present),
// so a rename or a moved block reds the guard instead of silently passing over an empty scan.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

const ROW = at('src/lib/components/QueueRow.svelte');
const PAGE = at('src/routes/+page.svelte');
const row = () => readFileSync(ROW, 'utf8');
const page = () => readFileSync(PAGE, 'utf8');
/*
 * moved the grip's own declarations out of QueueRow and into the shared Button, so the file
 * that must be scanned for the standard's `cursor: grab` is now this one. The invariant is UNCHANGED — the
 * declaration is still on the grip control and on no row — only its address moved.
 */
const BUTTON = at('src/lib/components/ui/button/button.svelte');
const button = () => readFileSync(BUTTON, 'utf8');

/** Blank both comment forms: this file's own rationale names the very strings it forbids. */
function stripComments(src: string): string {
	return src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
/** The markup region only — a `<style>` body is not a template. */
function markup(src: string): string {
	return stripComments(src).replace(/<style[\s\S]*?<\/style>/gi, '');
}

// ── the single-pointer alternative stays, and stays reachable ──────────────────────────

test('the grip IS the non-drag path, and it is a real button', () => {
	const m = markup(row());
	// Sentinel: we are reading the row template and it still has a grip at all.
	expect(m).toContain('data-grip=');
	/*
	 * A BUTTON, not a div with a handler — SC 2.1.1 needs it focusable and activatable by keyboard, and the
	 * `<Button>` primitive is what gives it the 44px `size="icon"` target and the focus ring.
	 */
	expect(m).toMatch(/<Button[^>]*data-grip=/s);
	// The keyboard step, which is what replaced the `move up` / `move down` pair.
	expect(m).toContain('aria-keyshortcuts="ArrowUp ArrowDown"');
	expect(m).toMatch(/onkeydown=/);
	expect(m).toMatch(/onnudge\?\.\(e\.key === 'ArrowUp' \? -1 : 1\)/);
	/*
	 * AND IT MUST NOT SCROLL THE PAGE INSTEAD. Arrow keys scroll by default, so a grip that did not
	 * `preventDefault` would move the row AND jump the list under it — which is the reorder equivalent of
	 * committing somewhere the guest did not choose.
	 */
	expect(m).toMatch(/e\.preventDefault\(\)/);
	/*
	 * THE RETIRED PAIR STAYS RETIRED, asserted rather than assumed: this arm's whole history is that the
	 * buttons had to be present unconditionally, so a reader who greps for them deserves to land on a
	 * failure that says they are gone on purpose.
	 */
	for (const gone of ['aria-label="move up"', 'aria-label="move down"'])
		expect(m, `${gone} was retired with the arrow pair — the grip carries the keyboard path now`).not.toContain(gone);
});

test('the label names the ACTION, so it is honest for both paths', () => {
	const m = markup(row());
	/*
	 * "Reorder — drag, or use arrow keys": the old label said "Reorder your songs", which described the
	 * drag and left a keyboard user to discover the rest. A control that is two paths must name both, and
	 * `aria-keyshortcuts` alone is not announced by every screen reader in every mode.
	 */
	const label = /aria-label="([^"]*)"[^>]*\n[^>]*aria-keyshortcuts/.exec(m)?.[1] ?? '';
	expect(m).toMatch(/aria-label="Reorder[^"]*arrow keys"/);
	void label;
});

test('the page commits a keyboard step through the pure predicate, not by arithmetic', () => {
	const p = page();
	// Sentinel: the page wires the row's nudge at all.
	expect(p).toMatch(/onnudge=\{\(delta\) => nudge\(e\.id, delta\)\}/);
	/*
	 * ROUTED THROUGH `keyboardMoveTarget`, which returns null at the ends of the list. A bare `i + delta`
	 * would emit a move to the position the row already occupies — a real mutation the server accepts and
	 * broadcasts, for a keypress that did nothing.
	 */
	expect(p).toMatch(/keyboardMoveTarget\(from, delta, queued\.length\)/);
	expect(p).toMatch(/if \(to === null\) return;/);
	// …and it announces, because the row moves under the guest's own focus.
	expect(p).toMatch(/liveMsg = `Moved to \$\{ordinal\(to \+ 1\)\} in the queue\.`/);
});

test('the grip goes inert while a move is unconfirmed', () => {
	const m = markup(row());
	/*
	 * The arrows used to carry this: they lived inside `{#if !pending}` with the remove button. The grip is
	 * in the row's MEDIA slot now (it leads the row), which is outside that gate — so it needs its own, or a
	 * second drag would issue an op against an index the server has not agreed to yet.
	 */
	expect(m).toMatch(/\{#if grip && !pending\}/);
});

// ── de-emphasis never uses subtree opacity ─────────────────────────────────────────────

test('the dimmed row is de-emphasised with a surface token, not opacity', () => {
	const src = row();
	const rule = /\.dimmed\s*\{([^}]*)\}/.exec(stripComments(src));
	expect(rule).not.toBeNull(); // sentinel: the rule exists to be judged
	const body = rule![1]!;
	expect(/background:\s*var\(--[\w-]+\)/.test(body)).toBe(true);
	expect(/border-color:\s*var\(--[\w-]+\)/.test(body)).toBe(true);
	// The defect this row exists to prevent, and the one `.pending` already records on this same row.
	expect(/(^|[;\s])opacity\s*:/.test(body)).toBe(false);
});

test('the dimmed row is not hidden from assistive tech', () => {
	// The dimmed rows stay INFORMATIONAL during the mode — they are who you are being ordered around —
	// so the mode must not reach for `inert` or `aria-hidden` on a row to make it non-interactive. It
	// drops the row's controls instead (`rowFrozen`).
	const m = markup(row());
	expect(m).not.toContain('inert');
	expect(m).not.toMatch(/aria-hidden=\{?["']?true/);
});

// ── cursor: grab exists only where a reorder is real ───────────────────────────────────

// `grab` must not match `grabbing`: the grip legitimately declares `cursor: grabbing` on :active, and
// a prefix match reported that as a second offender. Anchored on the value's own terminator.
const GRAB_RULE = /([^{}]+)\{([^}]*cursor:\s*grab\s*(?=[;}])[^}]*)\}/g;

test('cursor:grab is declared on the grip button and on no row', () => {
	/*
	 * RE-ANCHORED BY. This previously scanned QueueRow, where `.grip` declared its
	 * own cursor. The grip is now <Button press="grab">, so the declaration lives on the shared control
	 * keyed by that attribute. What is asserted is the same thing it always was: the grab cursor is on
	 * ONE selector, and that selector is the grip control rather than a row.
	 *
	 * The row is still scanned, by the sibling test below — a row-level grab reintroduced in QueueRow
	 * would red there, which is the regression this pair exists for.
	 */
	const src = stripComments(button());
	// Sentinel: the declaration exists at all, so an empty scan cannot pass this.
	expect(/cursor:\s*grab\s*[;}]/.test(src)).toBe(true);
	const grabRules = [...src.matchAll(GRAB_RULE)].map((m) => m[1]!.trim());
	expect(grabRules).toEqual(["[data-press='grab']"]); // exactly one, and it is the grip control

	// …and the row itself declares none, which is the half that must never regress.
	expect(/cursor:\s*grab\s*[;}]/.test(stripComments(row()))).toBe(false);
});

test('no other component reintroduces a row-level grab cursor', () => {
	// The removed affordance came back once already. Scanned across the two files this issue touches.
	for (const src of [stripComments(row()), stripComments(page())]) {
		for (const m of src.matchAll(GRAB_RULE)) {
			expect(m[1]!.trim()).toBe('.grip');
		}
	}
});

test('the grip binding goes through the predicate, never a literal', () => {
	// Found by mutation: `grip={true}` on every row left the whole suite green — and that is exactly the
	// recorded regression (a grip on another guest's song where it was the sole affordance). The
	// predicate's own tests cannot see this: they prove `gripVisible` answers correctly, not that the
	// template asks it.
	const m = markup(page());
	expect(m).toContain('grip={gripFor(e)}');
	expect(/grip=\{(true|false|!?\w+\.\w+)\}/.test(m)).toBe(false);

	// …and `gripFor` really forwards the queue-wide reorderability, so the grip cannot be hard-true. It
	// no longer reads `mine`: under `move-to-index` every queued row is draggable.
	const src = stripComments(page());
	const fn = /function gripFor\([\s\S]*?\n\t\}/.exec(src);
	expect(fn).not.toBeNull(); // sentinel
	const body = fn![0]!;
	expect(body).toContain('gripVisible(');
	expect(body).toContain('queuedCount: queued.length');
	expect(body).toContain('reorderMeaningful: canReorder');
	// The own-picks basis must be gone — a grip gated on `mine` would re-narrow the drag to own picks.
	expect(body).not.toContain('e.singerId === me?.id');
	expect(body).not.toContain('myPicks');
});

// ── the four invariants the DRIVEN run found, pinned cheaply ──────────────────────────────────────
//
// Each of these was a real defect that every test in this repo was green on, because each is about
// element identity or hit-testing rather than about a value. Each was found by DRIVING the mode in a
// real browser with a trusted pointer, and none of them is visible to a value-level test — so these
// scans are what keeps them from coming back. They are a floor, not a proof: the rendered rung for
// the target count and the focus return is still owed.

test('driven-find 1 · the drag listens on window, not on the grip element', () => {
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

test('driven-find 2 · the dragged row is transparent to hit-testing', () => {
	// The row is translated to sit under the finger with `z-index: 2`, so it was the topmost element at
	// the pointer and `elementFromPoint` returned IT instead of the drop slot beneath — a drag released
	// squarely on a legal target committed nothing.
	const rule = /\.moving\s*\{([^}]*)\}/.exec(stripComments(row()));
	expect(rule).not.toBeNull(); // sentinel
	expect(/pointer-events:\s*none/.test(rule![1]!)).toBe(true);
});

test('driven-find 3 · the drag-active state is separate from the drag SUBJECT', () => {
	// `.moving` carries `pointer-events: none`, so if it applied for as long as a row was the subject, that
	// row's own grip stayed untouchable and no later drag could start. Both props must read BOTH flags.
	const src = stripComments(page());
	expect(src).toContain('let dragging = $state(false)');
	expect(src).toContain('moving={movingId === e.id && dragging}');
	// Both operands, in this order, on the SAME prop — matched as a pattern rather than a literal only
	// because this tree writes a ternary's else-arm as `? x: 0` with no space before the colon.
	expect(src).toMatch(/dragY=\{movingId === e\.id && dragging \? dragY\s*:\s*0\}/);
	// Cleared on the exit path too, or a committed drag leaves the next row inert.
	const exit = /function endDrag\([\s\S]*?\n\t\}/.exec(src);
	expect(exit![0]).toContain('dragging = false');
});

test('driven-find 4 · there is no tap-versus-drop ambiguity left to get wrong', () => {
	/*
	 * RETIRED AND INVERTED (2026-09-21). This pinned `TAP_SLOP_PX`: treating every release as a drop made a
	 * TAP open the mode and immediately close it, because `hoverSlot` started at the row's own index so the
	 * release resolved to "move to where you already are". The threshold existed to tell the two apart.
	 *
	 * A live sort has no mode to open, so a press with no travel has nothing to resolve TO: `dragTo` is the
	 * row's own index, `commitMove` returns early when the target equals the current position, and the
	 * gesture ends having done nothing. The ambiguity is gone by construction rather than by a constant, so
	 * the arm asserts the construction — an early return on "same position" — and that the constant did not
	 * come back with a mode attached to it.
	 */
	const src = stripComments(page());
	expect(src).toMatch(/if \(from < 0 \|\| to === from\) return;/);
	expect(src, 'a tap threshold means a mode that a release could close by accident').not.toContain('TAP_SLOP_PX');
});

test('driven-find 5 · focus return is re-found by attribute, not by a held element', () => {
	// The grip the guest pressed is a detached node by the time the list has reordered, so focusing the
	// captured reference put focus nowhere — `activeElement` was `<body>` after Escape.
	const src = stripComments(page());
	expect(src).toContain('gripId={e.id}');
	expect(markup(row())).toContain('data-grip={gripId}');
	const exit = /function endDrag\([\s\S]*?\n\t\}/.exec(src);
	expect(exit![0]).toContain('data-grip=');
	expect(exit![0]).toContain('tick().then(');
	// The keyboard path re-finds it the same way, for the same reason: a nudge recreates the row's DOM.
	const nudge = /function nudge\([\s\S]*?\n\t\}/.exec(src);
	expect(nudge![0]).toContain('data-grip=');
});

test('· the .dimmed rule stays a surface token, not opacity — and no row is dimmed by the mode', () => {
	// The `.dimmed` rule is retained on both row kinds (the prop survives for a future mode that needs
	// it), and still governs its SHAPE: a surface token, never subtree opacity. But made
	// every queued row a legal drop target, so the mode dims NOTHING now — both call sites bind
	// `dimmed={false}`.
	const src = stripComments(readFileSync(at('src/lib/components/ProcessingCard.svelte'), 'utf8'));
	const rule = /\.dimmed\s*\{([^}]*)\}/.exec(src);
	expect(rule).not.toBeNull(); // sentinel
	const body = rule![1]!;
	expect(/background:\s*var\(--[\w-]+\)/.test(body)).toBe(true);
	expect(/(^|[;\s])opacity\s*:/.test(body)).toBe(false);
	// …and the mode no longer de-emphasises any row: both row kinds bind a constant false.
	expect((stripComments(page()).match(/dimmed=\{false\}/g) ?? []).length).toBe(2);
	expect(stripComments(page())).not.toContain('dimmed={reorderOpen');
});

// ── the mode's motion is CSS-driven ────────────────────────────────────────────────────

test('the drag is a CSS transform reading a var, with nothing interpolated over time', () => {
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

test('no drag library is pulled in for the mode', () => {
	// The requirement names `svelte-dnd-action` as the hazard: its motion is written as inline styles
	// by JS, which `motion.test.ts` cannot see by construction. The mode is built on Pointer Events +
	// a CSS var instead, so the enforcement gap is never opened.
	const src = page() + row();
	expect(src).not.toContain('svelte-dnd-action');
	expect(src).not.toContain('dndzone');
	const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8'));
	const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
	expect(Object.keys(deps)).not.toContain('svelte-dnd-action');
});

// ── the slots are drawn, and a drop cannot be approximated ────────────────────────────

test('the committed index IS the rendered one, so a release cannot land elsewhere', () => {
	/*
	 * REPLACED (2026-09-21), not dropped. Four arms here pinned the drawn drop targets: a `.dropslot` button
	 * per queued row carrying its ordinal, rendered only while the mode was open, derived from the whole
	 * queued list, and every release routed through `dropTarget` so an illegal drop committed nothing.
	 *
	 * The requirement was never the chrome — it is "a release cannot commit somewhere the guest did not
	 * choose". The live sort satisfies it by identity instead of by declining: `dragTo` is the one expression
	 * that both places the rows on screen and commits on release, so the two cannot disagree. That is what
	 * this arm pins, and it is a stronger claim than the old one could make — a drawn target could in
	 * principle be rendered at one index and resolved at another.
	 */
	const src = stripComments(page());
	// ONE derivation, read by both the render and the commit.
	expect(src).toMatch(/const dragTo = \$derived\(/);
	expect(src).toMatch(
		/liveSortTarget\(\{ fromIndex: dragFrom, offsetPx: dragY, rowBoundsPx: rowBounds, count: queued\.length \}\)/
	);
	/*
	 * …FED BY ONE READ, AT PRESS TIME. `rowBoundsPx` replaced a single `rowHeightPx` (2026-09-22) so a list
	 * that mixes queued rows with taller processing cards is placed exactly — but the property that made the
	 * single height safe has to survive the change, and it is a source claim: the boxes are measured in the
	 * POINTER-DOWN handler and nowhere else. Re-measuring mid-gesture is the recorded hazard (rows change
	 * height while a drag is in flight), so a second read inside the move handler is what this catches.
	 */
	const down = /function onGripPointerDown\([\s\S]*?\n\t\}/.exec(src)![0];
	expect(down, 'the boxes are measured once, on press').toMatch(/rowBounds = \[\.\.\.document\.querySelectorAll/);
	expect((src.match(/rowBounds = \[\.\.\.document/g) ?? []).length, 'exactly one place measures them').toBe(1);
	// The render reads it…
	expect(src).toMatch(/shift=\{rowShift\(i, dragFrom, dragTo\)\}/);
	// …and so does the release, through the shared commit rather than a second arithmetic.
	const end = /function endDrag\([\s\S]*?\n\t\}/.exec(src)![0];
	expect(end).toMatch(/commitMove\(id, to >= 0 \? to : null\)/);
	/*
	 * AND THE CHROME STAYS GONE. A reader who greps for the old mechanism should land on a failure that says
	 * it was deleted on purpose, not on a silent pass.
	 */
	for (const gone of ['dropslot', 'dropTarget', 'hoverSlot', 'queueSlots', 'reorder-bar'])
		expect(src, `\`${gone}\` belongs to the retired mode`).not.toContain(gone);
});

test('a drag that has not moved commits nothing, and neither does a cancel', () => {
	const src = stripComments(page());
	// `commit` false is the cancel path — Escape and an invalidation both take it.
	expect(src).toMatch(/function endDrag\(commit: boolean, note = ''\)/);
	expect(src).toMatch(/if \(commit && id\) commitMove/);
	expect(src).toMatch(/dragging && e\.key === 'Escape' && endDrag\(false\)/);
	// …and the invalidation path passes `false` with its reason, so a dissolving gesture cannot commit.
	expect(src).toMatch(/if \(reason\) endDrag\(false, reason\)/);
});

test('step 4 · every reorder — drag or keyboard — emits store.moveToIndex through ONE function', () => {
	/*
	 * Was: "the up/down arrows are wired to moveGlobal, which emits store.moveToIndex". The arrows and
	 * `moveGlobal` are both retired; the claim that mattered is that the two affordances share one wire path,
	 * so a fix to one cannot miss the other. There is now exactly one caller of the op.
	 */
	const src = stripComments(page());
	expect(src).toMatch(/function commitMove\(id: string, to: number \| null\)/);
	expect((src.match(/store\?\.moveToIndex\(/g) ?? []).length, 'one op call site, shared by both paths').toBe(1);
	expect(src).not.toContain('function moveGlobal');
});
