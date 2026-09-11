/*
 * THE SETTINGS TABLIST'S KEYBOARD CONTRACT, PROVEN BY MOUNTING IT (S4).
 *
 * `settings-scopes.test.ts` used to assert the hand-rolled implementation's exact source spelling,
 * because a source scan was all that was available: the settings page imports `$app`, so it cannot be
 * mounted. The shadcn migration replaced `onTabKey` with Bits UI's tablist, which deleted those expressions.
 *
 * The behaviour they stood in for is checked here instead, against a real render of the same primitive
 * the page uses. This is a STRONGER claim than the grep it replaces: "the file contains the string
 * ArrowRight" never established that pressing ArrowRight moved anything, and in particular never
 * established the pairing the old handler's own comment flagged as easy to forget — that focus must
 * move WITH the selection, "or the ring is left behind on the tab you just left".
 *
 * NON-VACUITY, MEASURED. Replacing the probe's primitive with a hand-rolled tablist — real
 * `role="tab"` buttons with `aria-selected` and a roving tabindex, but no key handler — reds exactly
 * the two keyboard arms and leaves the naming and tab-order arms green, which is the correct split:
 * that markup genuinely has the structure and genuinely lacks the behaviour. A first attempt mutated
 * the probe's `onValueChange` instead and changed nothing, because Bits UI keeps its own state — worth
 * recording, since it is the mutation a reader would reach for first.
 */
import { test, expect } from 'bun:test';
import { mount, flushSync } from '../../../../../test-setup/svelte-client';
import Probe from './tabs-keyboard-913.harness.svelte';

/** The rendered tabs, in document order. */
function tabsOf(host: HTMLElement): HTMLElement[] {
	return [...host.querySelectorAll('[role="tab"]')] as HTMLElement[];
}
const selected = (host: HTMLElement) => tabsOf(host).map((t) => t.getAttribute('aria-selected'));
const tabOrder = (host: HTMLElement) => tabsOf(host).map((t) => t.getAttribute('tabindex'));

function render(): HTMLElement {
	const host = document.createElement('div');
	document.body.appendChild(host);
	mount(Probe as never, { target: host });
	flushSync();
	return host;
}

/**
 * The Event constructor must come from the happy-dom window: bun defines its own global
 * `KeyboardEvent`, and the preload's `g[name] === undefined` copy leaves that one in place — so the
 * bare global builds an event the DOM under test does not recognise as a keyboard event.
 */
function press(el: HTMLElement, key: string): void {
	const Ctor = (globalThis as unknown as { window: { KeyboardEvent: typeof KeyboardEvent } }).window
		.KeyboardEvent;
	el.dispatchEvent(new Ctor('keydown', { key, bubbles: true }));
	flushSync();
}

test('the tablist is announced as one control with a name, not three loose buttons', () => {
	const host = render();
	const list = host.querySelector('[role="tablist"]');
	expect(list).not.toBeNull();
	expect(list!.getAttribute('aria-label')).toBe('Settings scope');
	// Non-vacuity: the harness really rendered the control. Every arrow-key arm below walks this list, so
	// a harness that mounted but produced no tabs would let all of them pass over an empty array — the
	// silent-green shape these behavioural arms exist to avoid.
	const triggers = tabsOf(host);
	expect(triggers.length).toBeGreaterThanOrEqual(3); // @nvf-floor triggers.length
	expect(triggers).toHaveLength(3);
	// Each tab owns a panel, which is what lets a screen reader move from tab to content.
	expect(host.querySelectorAll('[role="tabpanel"]').length).toBeGreaterThanOrEqual(1);
});

test('a roving tabindex puts exactly ONE tab in the tab order (the ARIA tabs pattern)', () => {
	const host = render();
	// Not "the first is 0": exactly one, anywhere. That is the invariant — three stops is the defect.
	expect(tabOrder(host).filter((t) => t === '0')).toHaveLength(1);
	expect(selected(host).filter((s) => s === 'true')).toHaveLength(1);
});

test('ArrowRight, Home and End move the selection AND the tab stop together (was onTabKey)', () => {
	const host = render();
	expect(selected(host)).toEqual(['true', 'false', 'false']);

	press(tabsOf(host)[0]!, 'ArrowRight');
	expect(selected(host)).toEqual(['false', 'true', 'false']);
	// The pairing the deleted handler had to remember by hand: the tab stop follows the selection, so
	// the focus ring is not left behind on the tab the user just left.
	expect(tabOrder(host)).toEqual(['-1', '0', '-1']);

	press(tabsOf(host)[1]!, 'End');
	expect(selected(host)).toEqual(['false', 'false', 'true']);
	expect(tabOrder(host)).toEqual(['-1', '-1', '0']);

	press(tabsOf(host)[2]!, 'Home');
	expect(selected(host)).toEqual(['true', 'false', 'false']);
	expect(tabOrder(host)).toEqual(['0', '-1', '-1']);
});

test('ArrowLeft from the first tab wraps to the last, as the old handler did with its modulo', () => {
	const host = render();
	press(tabsOf(host)[0]!, 'ArrowLeft');
	expect(selected(host)).toEqual(['false', 'false', 'true']);
});
