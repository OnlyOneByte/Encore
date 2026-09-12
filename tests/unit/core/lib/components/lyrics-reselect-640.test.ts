// — the LyricsReselect control's rendered behaviour, mounted (XR-PH-21 idiom: assert what renders
// and what a tap reports, not a source scan). Pins: the candidate list with provenance, the current
// pick marked, the pick/paste callbacks firing with the right payload, and the "a better version
// exists" peek. Each reds if the corresponding branch of the component is reverted.
import { test, expect, afterEach } from 'bun:test';
import { mount, unmount, flushSync } from '../../../../../tests/setup/svelte-client';
import LyricsReselect from '$lib/components/LyricsReselect.svelte';
import type { LyricsCandidate } from '$lib/contract';

let live: Array<{ comp: unknown; host: HTMLElement }> = [];
afterEach(() => {
	for (const { comp, host } of live) {
		void unmount(comp as never);
		host.remove();
	}
	live = [];
});

function render<P extends Record<string, unknown>>(props: P): HTMLElement {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const comp = mount(LyricsReselect as never, { target: host, props });
	flushSync();
	live.push({ comp, host });
	return host;
}

function open(host: HTMLElement): void {
	(host.querySelector('.reselect-toggle') as HTMLButtonElement).click();
	flushSync();
}

const cand = (ref: string, over: Partial<LyricsCandidate> = {}): LyricsCandidate => ({
	ref,
	textSource: 'lrclib',
	timing: 'word',
	textConfidence: 'high',
	createdAt: 1,
	...over
});

const SET: LyricsCandidate[] = [
	cand('r-lrclib', { textSource: 'lrclib', timing: 'word' }),
	cand('r-asr', { textSource: 'asr', timing: 'line', textConfidence: 'low' })
];

test('lists every candidate with a provenance label and marks the current pick', () => {
	const host = render({ candidates: SET, chosenRef: 'r-lrclib' });
	open(host);
	const opts = host.querySelectorAll('.reselect-opt');
	expect(opts.length).toBe(2);
	expect(host.textContent).toContain('Synced lyrics'); // lrclib label
	expect(host.textContent).toContain('Auto-transcribed'); // asr label
	const current = host.querySelector('.reselect-opt.current') as HTMLElement;
	expect(current.textContent).toContain('Synced lyrics'); // the chosen one is marked
});

test('tapping a candidate reports its ref via onpick', () => {
	let picked: string | undefined;
	const host = render({ candidates: SET, chosenRef: 'r-lrclib', onpick: (r: string) => (picked = r) });
	open(host);
	const asrOpt = [...host.querySelectorAll('.reselect-opt')].find((b) => b.textContent?.includes('Auto-transcribed'));
	(asrOpt as HTMLButtonElement).click();
	expect(picked).toBe('r-asr');
});

test('pasting reports the text via onpaste', () => {
	let pasted: string | undefined;
	const host = render({ candidates: SET, onpaste: (t: string) => (pasted = t) });
	open(host);
	(host.querySelector('.reselect-paste-open') as HTMLButtonElement).click();
	flushSync();
	const ta = host.querySelector('.reselect-textarea') as HTMLTextAreaElement;
	ta.value = 'my own words';
	const win = host.ownerDocument.defaultView as unknown as { Event: typeof Event };
	ta.dispatchEvent(new win.Event('input', { bubbles: true }));
	flushSync();
	// Addressed by `data-act`, not by a styling class. These two actions are the shared Button primitive
	// now, so there is no `.chip` class to key on — and keying a test on a class that exists only for the
	// test is what left an orphaned `.chip` selector in the component in the first place (the class had no
	// rule at all after the shadcn migration moved `.chip` into ui/badge, so both buttons rendered as native OS chrome).
	(host.querySelector('.reselect-acts [data-act="confirm"]') as HTMLButtonElement).click();
	expect(pasted).toBe('my own words');
});

test('the peek says "a better match is available" only when newerExists', () => {
	const yes = render({ candidates: SET, overrideRef: 'r-asr', newerExists: true });
	expect(yes.querySelector('.reselect-peek')!.textContent).toContain('better');
	const no = render({ candidates: SET, overrideRef: 'r-asr', newerExists: false });
	expect(no.querySelector('.reselect-peek')!.textContent).not.toContain('better');
});
