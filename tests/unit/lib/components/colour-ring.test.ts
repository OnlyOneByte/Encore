// ColourRing behaviour at the MOUNT rung: the KEYBOARD contract, the pips, and what the join actually
// submits.
//
// WHY THIS FILE EXISTS AT ALL. The join screen's colour picker used to be a preset radiogroup plus a
// native `<input type="range">`, and the range input brought its keyboard operation with it for free —
// arrows, Home/End, the announced value — because the platform implements a slider. The ring implements
// none of that: it is a `div[role="slider"]`, so every one of those behaviours is hand-written and can be
// deleted without anything else in the tree noticing. A source scan can see that a `keydown` handler
// exists; only a driven mount can see that ArrowRight moves ONE stop, that the ends WRAP, and that what a
// screen reader would say is the stop's NAME rather than its number.
//
// GEOMETRY IS NOT HERE, by enforcement: happy-dom's getBoundingClientRect throws, so the ring
// box, the knob's tap extent and the hub's fit are driven-browser readings. What is decidable without a
// layout engine is the state machine and the announced value, and that is what this pins.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mount, unmount, flushSync } from '$setup/svelte-client';
import ColourRing from '$lib/components/ColourRing.svelte';
import JoinLanding from '$lib/components/JoinLanding.svelte';
import { PALETTE_STOPS, paletteRingAngle, paletteStopAt } from '$lib/contract';

type StateStub = typeof import('$setup/kit/app-state');
const stateStub = async (): Promise<StateStub> => (await import('$app/state')) as unknown as StateStub;

// happy-dom's own KeyboardEvent — bun defines its own global, and happy-dom's dispatchEvent rejects an
// event that is not an instance of ITS classes (the mount-rung note).
const win = (globalThis as unknown as { window: Window & typeof globalThis }).window;

let realFetch: typeof fetch;
beforeEach(async () => {
	(await stateStub()).resetPage();
	realFetch = globalThis.fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

function mountRing(props: { value: string; taken?: readonly string[] } = { value: PALETTE_STOPS[0]!.fill }) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const instance = mount(ColourRing, { target, props });
	flushSync();
	const slider = () => target.querySelector('[role="slider"]') as HTMLElement;
	return { target, instance, slider };
}

function press(el: HTMLElement, key: string) {
	el.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
	flushSync();
}

/** What a screen reader would report: the index it is on, and the name it says. */
function readout(el: HTMLElement): { now: string | null; text: string | null } {
	return { now: el.getAttribute('aria-valuenow'), text: el.getAttribute('aria-valuetext') };
}

test('the ring is ONE slider over the whole palette, announced by stop NAME rather than by index', () => {
	const { slider, instance } = mountRing({ value: PALETTE_STOPS[21]!.fill }); // Turquoise, the mockup's pick
	try {
		const el = slider();
		expect(el, 'no role=slider rendered').not.toBeNull();
		// One tab stop, reachable — the property the retired radiogroup needed a roving tabindex for.
		expect(el.getAttribute('tabindex')).toBe('0');
		expect(el.getAttribute('aria-valuemin')).toBe('1');
		expect(el.getAttribute('aria-valuemax')).toBe(String(PALETTE_STOPS.length));
		expect(readout(el)).toEqual({ now: '22', text: 'Turquoise' });
		// The NAME is the point: "21" tells a reader nothing they can act on, which is why the palette is a
		// registry rather than a hue calculation.
		expect(el.getAttribute('aria-valuetext')).not.toBe('22');
	} finally {
		void unmount(instance);
	}
});

test('arrows move exactly one stop, in both directions, on both axes', () => {
	const { slider, instance } = mountRing({ value: PALETTE_STOPS[9]!.fill });
	try {
		const el = slider();
		press(el, 'ArrowRight');
		expect(readout(el)).toEqual({ now: '11', text: PALETTE_STOPS[10]!.name });
		press(el, 'ArrowLeft');
		expect(readout(el)).toEqual({ now: '10', text: PALETTE_STOPS[9]!.name });
		// Up/Down are the same axis for a slider (Up and Right increase), so a guest who reaches for either
		// pair gets the same movement rather than a dead key.
		press(el, 'ArrowUp');
		expect(readout(el)).toEqual({ now: '11', text: PALETTE_STOPS[10]!.name });
		press(el, 'ArrowDown');
		expect(readout(el)).toEqual({ now: '10', text: PALETTE_STOPS[9]!.name });
	} finally {
		void unmount(instance);
	}
});

test('the ends WRAP, because hue is cyclical — the last stop is not a dead end for a keyboard guest', () => {
	const last = PALETTE_STOPS.length;
	const { slider, instance } = mountRing({ value: PALETTE_STOPS[last - 1]!.fill });
	try {
		const el = slider();
		expect(readout(el).now).toBe(String(last));
		press(el, 'ArrowRight');
		expect(readout(el)).toEqual({ now: '1', text: PALETTE_STOPS[0]!.name });
		press(el, 'ArrowLeft');
		expect(readout(el)).toEqual({ now: String(last), text: PALETTE_STOPS[last - 1]!.name });
	} finally {
		void unmount(instance);
	}
});

test('Home and End jump to the first and last stop', () => {
	const { slider, instance } = mountRing({ value: PALETTE_STOPS[20]!.fill });
	try {
		const el = slider();
		press(el, 'Home');
		expect(readout(el)).toEqual({ now: '1', text: PALETTE_STOPS[0]!.name });
		press(el, 'End');
		expect(readout(el)).toEqual({ now: String(PALETTE_STOPS.length), text: PALETTE_STOPS.at(-1)!.name });
	} finally {
		void unmount(instance);
	}
});

test('a key the ring does not own is left to the page — it is not a swallow-everything handler', () => {
	const { slider, instance } = mountRing({ value: PALETTE_STOPS[0]!.fill });
	try {
		const el = slider();
		const ev = new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		el.dispatchEvent(ev);
		flushSync();
		expect(ev.defaultPrevented, 'Tab was consumed, so the ring is a keyboard trap').toBe(false);
		expect(readout(el).now).toBe('1');
		// …while a key it DOES own is consumed, or the arrow would scroll the page out from under the guest.
		const arrow = new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
		el.dispatchEvent(arrow);
		flushSync();
		expect(arrow.defaultPrevented).toBe(true);
	} finally {
		void unmount(instance);
	}
});

test('the knob is drawn at the selected stop’s own angle, which is what the mockup got wrong', () => {
	const { target, slider, instance } = mountRing({ value: PALETTE_STOPS[21]!.fill });
	try {
		const knob = target.querySelector('.cr-knob') as HTMLElement;
		expect(knob, 'no knob rendered').not.toBeNull();
		// The angle is published as a custom property, so this reads the value the transform consumes.
		expect(knob.getAttribute('style')).toContain(`--cr-a: ${paletteRingAngle(21)}deg`);
		// …and it FOLLOWS the selection rather than being a first-paint constant.
		press(slider(), 'ArrowRight');
		const moved = target.querySelector('.cr-knob') as HTMLElement;
		expect(moved.getAttribute('style')).toContain(`--cr-a: ${paletteRingAngle(22)}deg`);
	} finally {
		void unmount(instance);
	}
});

test('a colour somebody holds gets a pip; an empty room gets none, and duplicates get one', () => {
	const taken = [PALETTE_STOPS[3]!.fill, PALETTE_STOPS[30]!.fill, PALETTE_STOPS[30]!.fill];
	const withPips = mountRing({ value: PALETTE_STOPS[0]!.fill, taken });
	try {
		const pips = [...withPips.target.querySelectorAll('.cr-pip')] as HTMLElement[];
		// Two DISTINCT colours held by three people is two pips: a pip is a fact about the ring.
		expect(pips.length).toBe(2);
		expect(pips.map((p) => p.getAttribute('style'))).toEqual([
			`--cr-a: ${paletteRingAngle(3)}deg;`,
			`--cr-a: ${paletteRingAngle(30)}deg;`
		]);
	} finally {
		void unmount(withPips.instance);
	}
	const empty = mountRing({ value: PALETTE_STOPS[0]!.fill, taken: [] });
	try {
		expect(empty.target.querySelectorAll('.cr-pip').length).toBe(0);
	} finally {
		void unmount(empty.instance);
	}
});

test('a legacy colour the ring cannot produce still lands on a stop rather than at position 1', () => {
	// `#7c5cff` is SINGER_COLORS[0] — a preset at OKLCH L≈0.56, deliberately outside the ring's band, so
	// no stop equals it. An existing singer holding it must still see their knob somewhere sensible.
	const { slider, instance } = mountRing({ value: '#7c5cff' });
	try {
		const el = slider();
		const now = Number(readout(el).now);
		expect(now).toBeGreaterThanOrEqual(1);
		expect(now).toBeLessThanOrEqual(PALETTE_STOPS.length);
		// Not the fallback-to-first behaviour the nearest-hue match exists to avoid: violet sits in the
		// back half of the ring, so anything in the low single digits means the match collapsed.
		expect(now).toBeGreaterThan(30);
		expect(readout(el).text).toBe(paletteStopAt(now - 1).name);
	} finally {
		void unmount(instance);
	}
});

test('the join carries the colour the ring was left on — the binding reaches the POST, not just the knob', async () => {
	const { setPage } = await stateStub();
	setPage({ url: '/?room=K7MP2Q' });
	const bodies: string[] = [];
	globalThis.fetch = ((url: string, init?: { body?: string }) => {
		if (String(url).includes('/api/room-preview')) {
			return Promise.resolve(
				new Response(
					JSON.stringify({
						code: 'K7MP2Q',
						presentCount: 2,
						names: ['Maya', 'Dana'],
						// Real occupancy: the endpoint returns the present singers' colours, and the ring pips them.
						colors: [PALETTE_STOPS[5]!.fill, PALETTE_STOPS[40]!.fill]
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
			);
		}
		bodies.push(init?.body ?? '');
		return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
	}) as typeof fetch;

	const target = document.createElement('div');
	document.body.appendChild(target);
	const instance = mount(JoinLanding, { target });
	flushSync();
	try {
		// Let the preview land; until it does the pane is RESOLVING and carries no ring at all.
		for (let i = 0; i < 5; i++) {
			await new Promise((r) => setTimeout(r, 0));
			flushSync();
		}
		const ring = target.querySelector('[role="slider"]') as HTMLElement | null;
		expect(ring, 'the identity pane rendered no colour ring').not.toBeNull();
		// The two people in the room are pipped from the preview the sentence is built from.
		expect(target.querySelectorAll('.cr-pip').length).toBe(2);

		const input = target.querySelector("input[data-slot='input']") as HTMLInputElement;
		input.value = 'Ada';
		input.dispatchEvent(new win.Event('input', { bubbles: true }));
		flushSync();
		press(ring!, 'End');

		(target.querySelector('.submit-slot button') as HTMLButtonElement).click();
		flushSync();
		await Promise.resolve();
		await Promise.resolve();

		expect(bodies.length, 'the join button did not reach fetch').toBe(1);
		// The submitted colour is the stop the ring was left on — so `bind:value` really carries out of the
		// component, and the join cannot send a colour the picker never offered.
		expect(JSON.parse(bodies[0]!).color).toBe(PALETTE_STOPS.at(-1)!.fill);
	} finally {
		void unmount(instance);
	}
});
