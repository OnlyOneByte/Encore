// CodeEntry behaviour (XR-PH-14) at the MOUNT rung: the six-segment typed path's LOGIC —
// keystroke rejection of the excluded alphabet, auto-advance, backspace, a whole-code paste, and the
// completion callback. Driven with REAL InputEvent/KeyboardEvent/ClipboardEvent, because that logic is
// pure DOM-event handling and does not measure geometry.
//
// The SEGMENT GEOMETRY (six boxes, one tab stop, 320px reflow) is a rung-L driven-browser check by
// enforcement: happy-dom's getBoundingClientRect throws here (XR-VER-03), and the XR-PH-14 row says so.
// This file pins the parts that ARE decidable without a layout engine; each test reds on a revert of
// the hunk it targets.
import { test, expect } from 'bun:test';
import { mount, unmount, flushSync } from '$setup/svelte-client';
import CodeEntry from '$lib/components/CodeEntry.svelte';
import JoinLanding from '$lib/components/JoinLanding.svelte';

type StateStub = typeof import('$setup/kit/app-state');
const stateStub = async (): Promise<StateStub> => (await import('$app/state')) as unknown as StateStub;

// happy-dom's Event/InputEvent/KeyboardEvent — bun defines its own globals, and happy-dom's
// dispatchEvent rejects an event that is not an instance of ITS classes (the mount-rung note).
const win = (globalThis as unknown as { window: Window & typeof globalThis }).window;

function mountEntry() {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const seen = { complete: 0 };
	const instance = mount(CodeEntry, {
		target,
		props: {
			value: '',
			oncomplete: () => (seen.complete += 1)
		}
	});
	flushSync();
	const boxes = () => [...target.querySelectorAll('input.segment')] as HTMLInputElement[];
	return { target, instance, boxes, seen };
}

function typeChar(box: HTMLInputElement, ch: string) {
	// beforeinput with insertText is where the component accepts/rejects — dispatch the real thing.
	box.focus();
	const ev = new win.InputEvent('beforeinput', { data: ch, inputType: 'insertText', bubbles: true, cancelable: true });
	box.dispatchEvent(ev);
	flushSync();
}

function readCode(boxes: HTMLInputElement[]): string {
	return boxes.map((b) => b.value).join('');
}

test('an admitted character is accepted, upper-cased, and advances to the next box', () => {
	const { boxes, instance } = mountEntry();
	try {
		typeChar(boxes()[0], 'a'); // lower-case, admitted -> 'A'
		expect(boxes()[0].value).toBe('A');
		// Focus advanced to box 2.
		expect(document.activeElement).toBe(boxes()[1]);
	} finally {
		void unmount(instance);
	}
});

test('an excluded character is rejected — nothing entered, a reason shown', () => {
	const { target, boxes, instance } = mountEntry();
	try {
		typeChar(boxes()[0], 'O'); // excluded
		typeChar(boxes()[0], '1'); // excluded
		typeChar(boxes()[0], 'l'); // excluded
		expect(readCode(boxes())).toBe('');
		// SC 3.3.1: the reason names the excluded characters, in the polite live region.
		const note = target.querySelector('.code-note') as HTMLElement;
		expect(note.textContent).toContain('O');
	} finally {
		void unmount(instance);
	}
});

test('backspace on an empty box steps back and clears the previous one', () => {
	const { boxes, instance } = mountEntry();
	try {
		typeChar(boxes()[0], 'A');
		typeChar(boxes()[1], 'B');
		// caret now in box 3 (empty). Backspace should clear box 2 and move focus there.
		boxes()[2].focus();
		boxes()[2].dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
		flushSync();
		expect(boxes()[1].value).toBe('');
		expect(document.activeElement).toBe(boxes()[1]);
	} finally {
		void unmount(instance);
	}
});

test('a six-character paste into the first box fills all six and fires oncomplete', () => {
	const { boxes, instance, seen } = mountEntry();
	try {
		const dt = new win.DataTransfer();
		dt.setData('text', 'abcd23');
		boxes()[0].focus();
		boxes()[0].dispatchEvent(new win.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
		flushSync();
		expect(readCode(boxes())).toBe('ABCD23');
		expect(seen.complete).toBeGreaterThanOrEqual(1);
	} finally {
		void unmount(instance);
	}
});

test('a paste with punctuation is cleaned to the admitted characters', () => {
	const { boxes, instance } = mountEntry();
	try {
		const dt = new win.DataTransfer();
		dt.setData('text', 'AB-CD 2O3'); // O dropped, punctuation/space dropped -> ABCD23
		boxes()[0].focus();
		boxes()[0].dispatchEvent(new win.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
		flushSync();
		expect(readCode(boxes())).toBe('ABCD23');
	} finally {
		void unmount(instance);
	}
});

// ── AC2: "5 of 6 segments filled -> Continue disabled" ───────────────────────────────
// The criterion is delivered at JoinLanding.svelte's `disabled={!canJoin}`, but nothing pinned it:
// `canJoin` is referenced nowhere else, so `disabled={false}` left the whole suite green. This mounts
// the REAL JoinLanding (unjoined, no `?room`), fills the name so the ONLY thing gating Continue is the
// code length, then drives the six-box entry through `typeChar` and reads the button's `disabled`.
// Reds on the `disabled={false}` mutation the reviewer named.
async function mountLandingForAc2() {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const instance = mount(JoinLanding, { target });
	flushSync();
	const segs = () => [...target.querySelectorAll('input.segment')] as HTMLInputElement[];
	// the field is <Input> now, so its appearance (and `.name-input`) lives in the component.
	// `data-slot` is shadcn's own contract for the rendered element and survives a re-vendor.
	const continueBtn = () => target.querySelector('.submit-slot button') as HTMLButtonElement;
	return { target, instance, segs, continueBtn };
}

test('AC2 — Continue is disabled at 5 of 6 code characters, enabled at 6', async () => {
	(await stateStub()).resetPage(); // bare `/`, no ?room — the typed path
	const { instance, segs, continueBtn } = await mountLandingForAc2();
	try {
		/*
		 * NO NAME TO FILL ANY MORE, and that makes this assertion stronger rather than weaker.
		 *
		 * This used to type a name first, and said why: "a missing name would disable it for a different
		 * reason and make the assertion prove nothing". The two-pane split removed that confound at the
		 * source — the code pane carries no name field, so code length is the ONLY gate on Continue by
		 * construction. The setup that compensated for the coupling goes with the coupling.
		 */

		// Type FIVE of six characters.
		const five = 'ABCD2';
		for (let i = 0; i < five.length; i++) typeChar(segs()[i], five[i]!);
		expect(continueBtn().disabled, 'Continue must stay disabled at 5 of 6 characters').toBe(true);

		/*
		 * THE SIXTH CHARACTER NOW RESOLVES THE CODE ITSELF, so the boundary this criterion is about shows up
		 * as "no longer blocked by length" rather than as a literally enabled button.
		 *
		 * AC2 is about the LENGTH gate: at five characters Continue must refuse, at six it must not. What
		 * changed underneath it is that the sixth keystroke also fires `oncomplete`, which starts the
		 * room lookup — and `canContinue` is `length === 6 && !previewLoading`, so for as long as that fetch
		 * is in flight the button is legitimately disabled again, with its label reading "Checking the code…".
		 * (It used to fire and do nothing: `oncomplete` ran before the bound value reached the parent, so the
		 * auto-advance silently no-opped. Typing the sixth character and pasting a whole code both left the
		 * guest on step 1.)
		 *
		 * So the assertion is on the DISJUNCTION, and each half is checked for the right reason: either the
		 * button is enabled (the lookup has not started or has already failed) or the pane is mid-resolve.
		 * Asserting only `disabled === false` would now be asserting that the auto-advance does NOT happen.
		 */
		typeChar(segs()[5], '3');
		const btn = continueBtn();
		const resolving = /Checking the code/.test(btn.textContent ?? '');
		expect(
			!btn.disabled || resolving,
			'at six characters Continue must no longer be blocked by LENGTH — it is either enabled, or already resolving the code'
		).toBe(true);
		// And the length gate really is gone: the disabled reason, if any, is the lookup and not the count.
		expect(
			(document.querySelector('.cta-reason')?.textContent ?? '').includes('characters'),
			'no length complaint may remain at six characters'
		).toBe(false);
	} finally {
		void unmount(instance);
	}
});
