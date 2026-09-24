// Reordering's source-decidable half: claims about what the row/page template can never do, rather than about
// a value it computes. WCAG 2.5.7 / 2.1.1 lives here because the requirement is that NO state removes the
// keyboard path. Every test asserts a SENTINEL first, so a rename reds the guard instead of scanning nothing.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';
import { stripComments } from '@encore/test-support/scan';

const ROW = at('src/lib/components/QueueRow.svelte');
const PAGE = at('src/routes/+page.svelte');
const row = () => readFileSync(ROW, 'utf8');
const page = () => readFileSync(PAGE, 'utf8');
// The grip's declarations live on the shared Button, so that is where `cursor: grab` is scanned for.
const BUTTON = at('src/lib/components/ui/button/button.svelte');
const button = () => readFileSync(BUTTON, 'utf8');

/**
 * Comments come off because an absence arm must read CODE and not prose: the source deliberately names the
 * very mechanisms banned below, so a ban that saw a comment would red on the explanation.
 */
function markup(src: string): string {
	return stripComments(src, { markup: true, drop: true }).replace(/<style[\s\S]*?<\/style>/gi, '');
}

test('the grip IS the non-drag path, and it is a real button', () => {
	const m = markup(row());
	expect(m).toContain('data-grip=');
	// A BUTTON, not a div with a handler: SC 2.1.1 needs it focusable and keyboard-activatable, and `<Button>`
	// gives it the 44px `size="icon"` target and the focus ring. preventDefault, or the arrows also scroll.
	expect(m).toMatch(/<Button[^>]*data-grip=/s);
	expect(m).toContain('aria-keyshortcuts="ArrowUp ArrowDown"');
	expect(m).toMatch(/onkeydown=/);
	expect(m).toMatch(/onnudge\?\.\(e\.key === 'ArrowUp' \? -1 : 1\)/);
	expect(m).toMatch(/e\.preventDefault\(\)/);
	for (const gone of ['aria-label="move up"', 'aria-label="move down"'])
		expect(m, `${gone} was retired with the arrow pair — the grip carries the keyboard path now`).not.toContain(gone);
});

test('the label names the ACTION, so it is honest for both paths', () => {
	const m = markup(row());
	expect(m).toMatch(/aria-label="Reorder[^"]*arrow keys"/);
});

test('the page commits a keyboard step through the pure predicate, not by arithmetic', () => {
	const p = page();
	expect(p).toMatch(/onnudge=\{\(delta\) => nudge\(e\.id, delta\)\}/);
	// Routed through `keyboardMoveTarget`, which returns null at the ends: a bare `i + delta` would emit a move to
	// the position the row already occupies — a real mutation the server accepts and broadcasts, for nothing.
	expect(p).toMatch(/keyboardMoveTarget\(from, delta, queued\.length\)/);
	expect(p).toMatch(/if \(to === null\) return;/);
	expect(p).toMatch(/liveMsg = `Moved to \$\{ordinal\(to \+ 1\)\} in the queue\.`/);
});

test('the grip goes inert while a move is unconfirmed', () => {
	const m = markup(row());
	// The grip is in the row's MEDIA slot, outside the `{#if !pending}` gate the remove button sits in, so it needs
	// its own — or a second drag issues an op against an index the server has not agreed to yet.
	expect(m).toMatch(/\{#if grip && !pending\}/);
});

test('the dimmed row is de-emphasised with a surface token, not opacity', () => {
	const src = row();
	const rule = /\.dimmed\s*\{([^}]*)\}/.exec(stripComments(src, { markup: true, drop: true }));
	expect(rule).not.toBeNull(); // sentinel: the rule exists to be judged
	const body = rule![1]!;
	expect(/background:\s*var\(--[\w-]+\)/.test(body)).toBe(true);
	expect(/border-color:\s*var\(--[\w-]+\)/.test(body)).toBe(true);
	expect(/(^|[;\s])opacity\s*:/.test(body)).toBe(false);
});

test('the dimmed row is not hidden from assistive tech', () => {
	const m = markup(row());
	expect(m).not.toContain('inert');
	expect(m).not.toMatch(/aria-hidden=\{?["']?true/);
});

// `grab` must not match `grabbing`: the grip legitimately declares `cursor: grabbing` on :active, and
// a prefix match reported that as a second offender. Anchored on the value's own terminator.
const GRAB_RULE = /([^{}]+)\{([^}]*cursor:\s*grab\s*(?=[;}])[^}]*)\}/g;

test('cursor:grab is declared on the grip button and on no row', () => {
	// Scanned on the shared Button because the grip is <Button press="grab">: the grab cursor is on ONE selector
	// and that selector is the grip control, not a row.
	const src = stripComments(button(), { markup: true, drop: true });
	expect(/cursor:\s*grab\s*[;}]/.test(src)).toBe(true);
	const grabRules = [...src.matchAll(GRAB_RULE)].map((m) => m[1]!.trim());
	expect(grabRules).toEqual(["[data-press='grab']"]); // exactly one, and it is the grip control

	expect(/cursor:\s*grab\s*[;}]/.test(stripComments(row(), { markup: true, drop: true }))).toBe(false);
});

test('no other component reintroduces a row-level grab cursor', () => {
	// An ABSENCE, not a per-match check. The old form looped the matches and asserted each selector was
	// `.grip`, which examined nothing (the sibling above proves the row declares no grab rule at all) and
	// would have WAVED THROUGH a `.grip { cursor: grab }` on the row — the very thing the sibling bans.
	for (const [name, src] of [
		['row', stripComments(row(), { markup: true, drop: true })],
		['page', stripComments(page(), { markup: true, drop: true })]
	] as const) {
		expect(
			[...src.matchAll(GRAB_RULE)].map((m) => m[1]!.trim()),
			name
		).toEqual([]);
	}
	// Sentinel: the regex still fires, so the two empties above mean "no rule" and not "no match".
	expect([...'.qrow { cursor: grab; }'.matchAll(GRAB_RULE)].map((m) => m[1]!.trim())).toEqual(['.qrow']);
});

test('the grip binding goes through the predicate, never a literal', () => {
	// Found by mutation: `grip={true}` on every row left the whole suite green — a grip on another guest's song
	// where it was the sole affordance.
	const m = markup(page());
	expect(m).toContain('grip={gripFor(e)}');
	expect(/grip=\{(true|false|!?\w+\.\w+)\}/.test(m)).toBe(false);

	const src = stripComments(page(), { markup: true, drop: true });
	const fn = /function gripFor\([\s\S]*?\n\t\}/.exec(src);
	expect(fn).not.toBeNull(); // sentinel
	const body = fn![0]!;
	expect(body).toContain('gripVisible(');
	expect(body).toContain('queuedCount: queued.length');
	expect(body).toContain('reorderMeaningful: canReorder');
	expect(body).not.toContain('e.singerId === me?.id');
	expect(body).not.toContain('myPicks');
});

test('driven-find 1 · the drag listens on window, not on the grip element', () => {
	// Opening the mode re-renders the rows, so the pressed grip becomes a DETACHED node: listeners bound to it
	// delivered nothing, and a real drag moved no row and never closed the mode. A pointer CAPTURE on that node
	// is the same defect.
	const src = stripComments(page(), { markup: true, drop: true });
	const fn = /function onGripPointerDown\([\s\S]*?\n\t\}/.exec(src);
	expect(fn).not.toBeNull(); // sentinel
	const body = fn![0]!;
	for (const ev of ['pointermove', 'pointerup', 'pointercancel']) {
		expect(body).toContain(`window.addEventListener('${ev}'`);
		expect(body).toContain(`window.removeEventListener('${ev}'`);
		expect(body.includes(`grip.addEventListener('${ev}'`)).toBe(false);
	}
	expect(/setPointerCapture/.test(body)).toBe(false);
});

test('driven-find 2 · the dragged row is transparent to hit-testing', () => {
	// The row is translated under the finger with `z-index: 2`, so it was topmost and `elementFromPoint` returned
	// IT instead of the drop slot beneath: a drag released on a legal target committed nothing.
	const rule = /\.moving\s*\{([^}]*)\}/.exec(stripComments(row(), { markup: true, drop: true }));
	expect(rule).not.toBeNull(); // sentinel
	expect(/pointer-events:\s*none/.test(rule![1]!)).toBe(true);
});

test('driven-find 3 · the drag-active state is separate from the drag SUBJECT', () => {
	// `.moving` carries `pointer-events: none`, so if it applied for as long as a row was the SUBJECT, that row's
	// own grip stayed untouchable and no later drag could start. Both props must read BOTH flags, and both must be
	// cleared on the exit path or a committed drag leaves the next row inert.
	const src = stripComments(page(), { markup: true, drop: true });
	expect(src).toContain('let dragging = $state(false)');
	expect(src).toContain('moving={movingId === e.id && dragging}');
	expect(src).toMatch(/dragY=\{movingId === e\.id && dragging \? dragY\s*:\s*0\}/);
	const exit = /function endDrag\([\s\S]*?\n\t\}/.exec(src);
	expect(exit![0]).toContain('dragging = false');
});

test('driven-find 4 · there is no tap-versus-drop ambiguity left to get wrong', () => {
	const src = stripComments(page(), { markup: true, drop: true });
	expect(src).toMatch(/if \(from < 0 \|\| to === from\) return;/);
	expect(src, 'a tap threshold means a mode that a release could close by accident').not.toContain('TAP_SLOP_PX');
});

test('driven-find 5 · focus return is re-found by attribute, not by a held element', () => {
	// The pressed grip is detached once the list has reordered, so focusing the captured reference put focus
	// nowhere — `activeElement` was `<body>` after Escape. The keyboard path re-finds it the same way, because a
	// nudge recreates the row's DOM too.
	const src = stripComments(page(), { markup: true, drop: true });
	expect(src).toContain('gripId={e.id}');
	expect(markup(row())).toContain('data-grip={gripId}');
	const exit = /function endDrag\([\s\S]*?\n\t\}/.exec(src);
	expect(exit![0]).toContain('data-grip=');
	expect(exit![0]).toContain('tick().then(');
	const nudge = /function nudge\([\s\S]*?\n\t\}/.exec(src);
	expect(nudge![0]).toContain('data-grip=');
});

test('· the .dimmed rule stays a surface token, not opacity — and no row is dimmed by the mode', () => {
	// `.dimmed` is retained on both row kinds (the prop survives for a future mode) and still governs its SHAPE: a
	// surface token, never subtree opacity. Every queued row is a legal target, so nothing is dimmed.
	const src = stripComments(readFileSync(at('src/lib/components/ProcessingCard.svelte'), 'utf8'), {
		markup: true,
		drop: true
	});
	const rule = /\.dimmed\s*\{([^}]*)\}/.exec(src);
	expect(rule).not.toBeNull(); // sentinel
	const body = rule![1]!;
	expect(/background:\s*var\(--[\w-]+\)/.test(body)).toBe(true);
	expect(/(^|[;\s])opacity\s*:/.test(body)).toBe(false);
	expect((stripComments(page(), { markup: true, drop: true }).match(/dimmed=\{false\}/g) ?? []).length).toBe(2);
	expect(stripComments(page(), { markup: true, drop: true })).not.toContain('dimmed={reorderOpen');
});

test('the drag is a CSS transform reading a var, with nothing interpolated over time', () => {
	const src = stripComments(row(), { markup: true, drop: true });
	const moving = /\.moving\s*\{([^}]*)\}/.exec(src);
	expect(moving).not.toBeNull(); // sentinel
	const body = moving![1]!;
	// The position comes from a custom property through `transform` — GPU-composited, the only kind
	// `motion.test.ts` permits animating. No duration either: a 1:1 response to the pointer is not an animation.
	expect(/transform:\s*translateY\(var\(--drag-y/.test(body)).toBe(true);
	expect(/transition/.test(body)).toBe(false);
	expect(/animation/.test(body)).toBe(false);
});

test('no drag library is pulled in for the mode', () => {
	// `svelte-dnd-action` is the named hazard: its motion is inline styles written by JS, which `motion.test.ts`
	// cannot see by construction.
	const src = page() + row();
	expect(src).not.toContain('svelte-dnd-action');
	expect(src).not.toContain('dndzone');
	const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8'));
	const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
	expect(Object.keys(deps)).not.toContain('svelte-dnd-action');
});

test('the committed index IS the rendered one, so a release cannot land elsewhere', () => {
	// "A release cannot commit somewhere the guest did not choose" holds by IDENTITY: `dragTo` is the ONE
	// expression that both places the rows on screen and commits on release, so they cannot disagree.
	const src = stripComments(page(), { markup: true, drop: true });
	expect(src).toMatch(/const dragTo = \$derived\(/);
	expect(src).toMatch(
		/liveSortTarget\(\{ fromIndex: dragFrom, offsetPx: dragY, rowBoundsPx: rowBounds, count: queued\.length \}\)/
	);
	// …fed by ONE read, at press time: re-measuring mid-gesture is the hazard, because rows change height while a
	// drag is in flight.
	const down = /function onGripPointerDown\([\s\S]*?\n\t\}/.exec(src)![0];
	expect(down, 'the boxes are measured once, on press').toMatch(/rowBounds = \[\.\.\.document\.querySelectorAll/);
	expect((src.match(/rowBounds = \[\.\.\.document/g) ?? []).length, 'exactly one place measures them').toBe(1);
	expect(src).toMatch(/shift=\{rowShift\(i, dragFrom, dragTo\)\}/);
	const end = /function endDrag\([\s\S]*?\n\t\}/.exec(src)![0];
	expect(end).toMatch(/commitMove\(id, to >= 0 \? to : null\)/);
	for (const gone of ['dropslot', 'dropTarget', 'hoverSlot', 'queueSlots', 'reorder-bar'])
		expect(src, `\`${gone}\` belongs to the retired mode`).not.toContain(gone);
});

test('a drag that has not moved commits nothing, and neither does a cancel', () => {
	const src = stripComments(page(), { markup: true, drop: true });
	expect(src).toMatch(/function endDrag\(commit: boolean, note = ''\)/);
	expect(src).toMatch(/if \(commit && id\) commitMove/);
	expect(src).toMatch(/dragging && e\.key === 'Escape' && endDrag\(false\)/);
	expect(src).toMatch(/if \(reason\) endDrag\(false, reason\)/);
});

test('step 4 · every reorder — drag or keyboard — emits store.moveToIndex through ONE function', () => {
	const src = stripComments(page(), { markup: true, drop: true });
	expect(src).toMatch(/function commitMove\(id: string, to: number \| null\)/);
	expect((src.match(/store\?\.moveToIndex\(/g) ?? []).length, 'one op call site, shared by both paths').toBe(1);
	expect(src).not.toContain('function moveGlobal');
});
