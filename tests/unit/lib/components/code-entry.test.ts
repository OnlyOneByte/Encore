// CodeEntry's LOGIC at the MOUNT rung — keystroke rejection of the excluded alphabet, auto-advance,
// backspace, a whole-code paste, the completion callback — driven with REAL
// InputEvent/KeyboardEvent/ClipboardEvent, since that is pure DOM-event handling. The segment GEOMETRY
// (six boxes, one tab stop, 320px reflow) belongs to the layout rung: getBoundingClientRect throws here.
import { test, expect } from 'bun:test';
import { mount, unmount, flushSync } from '$setup/svelte-client';
import CodeEntry from '$lib/components/CodeEntry.svelte';
import JoinLanding from '$lib/components/JoinLanding.svelte';

type StateStub = typeof import('$setup/kit/app-state');
const stateStub = async (): Promise<StateStub> => (await import('$app/state')) as unknown as StateStub;

// happy-dom's own Event classes: bun defines its own globals, and happy-dom's dispatchEvent rejects an
// event that is not an instance of ITS classes.
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
	// beforeinput/insertText is where the component accepts or rejects, so dispatch the real thing.
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
		// Caret in box 3 (empty), so Backspace clears box 2 and moves focus there.
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

// Five of six segments filled must leave Continue DISABLED. The criterion is delivered by
// `disabled={!canJoin}` in JoinLanding.svelte and `canJoin` is referenced nowhere else, so a
// `disabled={false}` mutation leaves the whole suite green. Mounts the REAL JoinLanding, unjoined and
// with no `?room`, and drives the six-box entry.
async function mountLandingForAc2() {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const instance = mount(JoinLanding, { target });
	flushSync();
	const segs = () => [...target.querySelectorAll('input.segment')] as HTMLInputElement[];
	// `data-slot` is shadcn's own contract for the rendered element and survives a re-vendor.
	const continueBtn = () => target.querySelector('.submit-slot button') as HTMLButtonElement;
	return { target, instance, segs, continueBtn };
}

test('AC2 — Continue is disabled at 5 of 6 code characters, enabled at 6', async () => {
	(await stateStub()).resetPage(); // bare `/`, no ?room — the typed path
	const { instance, segs, continueBtn } = await mountLandingForAc2();
	try {
		// No name to fill: the code pane carries no name field, so code LENGTH is the only gate on Continue
		// by construction, and nothing else can disable it for a different reason.

		const five = 'ABCD2';
		for (let i = 0; i < five.length; i++) typeChar(segs()[i], five[i]!);
		expect(continueBtn().disabled, 'Continue must stay disabled at 5 of 6 characters').toBe(true);

		// The claim is about the LENGTH gate, and the sixth keystroke also fires `oncomplete`, which starts
		// the room lookup — and `canContinue` is `length === 6 && !previewLoading`, so while that fetch is in
		// flight the button is legitimately disabled again. Hence a DISJUNCTION: either enabled, or
		// mid-resolve. Asserting `disabled === false` alone would assert the auto-advance does NOT happen.
		typeChar(segs()[5], '3');
		const btn = continueBtn();
		const resolving = /Checking the code/.test(btn.textContent ?? '');
		expect(
			!btn.disabled || resolving,
			'at six characters Continue must no longer be blocked by LENGTH — it is either enabled, or already resolving the code'
		).toBe(true);
		// The length gate is gone: any remaining disabled reason is the lookup, not the count.
		expect(
			(document.querySelector('.cta-reason')?.textContent ?? '').includes('characters'),
			'no length complaint may remain at six characters'
		).toBe(false);
	} finally {
		void unmount(instance);
	}
});
