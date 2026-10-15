import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';

/*
 * guard: every `RoomLink.command` call site reads the boolean it returns.
 *
 * `command` reports whether the frame reached the wire, and a PLAYER command is NOT resent on resync the way a
 * queue add is (`QueueStore.resendPending` has no counterpart on that path), so a dropped one is simply lost.
 * docs/UI-REVIEW.md finding C is the record: all five sites discarded the boolean, the only report was a
 * `console.warn`, and two of the five held an optimistic value — so the ± keycap showed a shift the server had
 * never heard and the guide slider followed the finger through a drag the room never heard and then sprang back.
 *
 * WHY A SOURCE SCAN. These are five lines of wiring inside `.svelte` files, and the component-mount harness is
 * gone (bunfig.toml records why) — a browser can see the control move but not whether the boolean was consulted,
 * and the window where a send fails while the socket still reads connected is not reachable from a spec. The
 * ARITHMETIC behind the slider is a real behavioural test instead, in guide-send.test.ts; what is here is the
 * wiring between it and the route, plus the three transport buttons, which hold no optimistic state at all and so
 * have nothing testable except who they call.
 *
 * The exhaustiveness test at the bottom is the one that matters most: it is what makes a SIXTH call site, added
 * later and discarding the boolean again, red rather than invisible.
 */

const layout = readFileSync(at('src/routes/+layout.svelte'), 'utf8');
const queuePage = readFileSync(at('src/routes/queue/+page.svelte'), 'utf8');

test('the transport buttons go through one reporting helper, not three bare sends', () => {
	// One helper, because three copies of the same `if (!room.command(...))` is how two of them keep the old copy.
	expect(layout).toContain('function transport(command: PlayerCommand): void {');
	expect(layout).toContain('if (room.command(command)) return;');
	expect(layout).toContain("onrestart={() => transport({ cmd: 'restart' })}");
	expect(layout).toContain("ontoggleplay={() => transport({ cmd: isPlaying ? 'pause' : 'play' })}");
	expect(layout).toContain("onskip={() => transport({ cmd: 'skip' })}");
});

test('the notice carries a stable id, so a mash is one notice rather than a tower of them', () => {
	/* Sonner keys toasts by `id`: a create against an id already on screen UPDATES that toast (and sets
	   `updated`, which resets its auto-close timer) instead of pushing another. Without the id, a guest tapping
	   skip five times at a dead socket gets five stacked error toasts over the dock. */
	expect(layout).toContain("{ id: 'transport-dropped', duration: 4000 }");
	/* `toast.error`, not `toast.warning`, and the severity split FRONTEND.md states is the reason: --warn is for
	   a transient failure and the dock's bar is correctly one, because the socket self-heals on the next backoff
	   tick. This does not — the command is gone and only the guest can reissue it. (The assertion is on the
	   CHANNEL, which is the decision; sonner paints its error toast on its own surface rather than on --danger.)
	   4000ms matches /queue's own error sink, so two notices on one surface do not linger for different spans. */
	expect(layout).toMatch(/toast\.error\("Not connected — the TV didn't hear that\."/);
});

test('the dock keeps its own offline bar, which answers the OTHER question', () => {
	/* The per-tap notice does not replace the bar and must not be read as making it redundant: the bar is up for
	   the whole outage and says the link is down, the notice says one specific command was lost. Deleting either
	   leaves a real gap, so both are pinned. */
	expect(layout).toContain('{#if !connected}');
	expect(layout).toContain('class="offline-bar"');
	expect(layout).toContain('Reconnecting…');
});

test('the one toaster clears the dock at BOTH of sonner breakpoints, and only on the bottom', () => {
	/* The notice is useless if it covers the control it is about, and it did. Two separate traps, both measured
	   at 390x844 with the offline bar up (--dock-h 116px, dock top 728, buttons 754-798):
	     · sonner reads `--offset-bottom` only ABOVE its 600px breakpoint and `--mobile-offset-bottom` at or
	       below it, and the `offset` prop feeds the first alone — so every phone width used its `mobileOffset`
	       DEFAULT of 16px and the toast's box sat at 774.5-828, over all three transport buttons.
	     · a scalar offset is `assignAll`ed to all four sides, so `--dock-h + 16px` as a string also inset left
	       and right by 132px: the toast narrowed to 126px of 390 and one sentence wrapped onto four lines.
	   Naming only `bottom`, on both props, is what satisfies both. A string here is the regression, and it is
	   invisible in a diff. */
	expect(layout).toContain("offset={{ bottom: 'calc(var(--dock-h, 0px) + 24px)' }}");
	expect(layout).toContain("mobileOffset={{ bottom: 'calc(var(--dock-h, 0px) + 16px)' }}");
});

test('the guide slider holds ONE nullable draft, not a drag-scoped flag beside a number', () => {
	/* `guideDragging ? guideDraft : guideServerPct` is the shape that sprang back on release: the flag cleared
	   synchronously, so the readout fell through to a server echo that had not arrived yet even when the command
	   had landed. A nullable draft cannot express that state. */
	expect(queuePage).toContain('let guideDraft = $state<number | null>(null);');
	expect(queuePage).toContain('const guidePct = $derived(guideDraft ?? guideServerPct);');
	/* The two defective SHAPES, not the bare word — the comment above the draft names what it replaced, which is
	   the account a reader needs and which a file-wide negative would forbid writing down. */
	expect(queuePage).not.toContain('let guideDragging');
	expect(queuePage).not.toContain('guideDragging ? guideDraft');
});

test('the guide draft is cleared by the ROOM agreeing, and by a song change', () => {
	/* The same two arms `keyDraft`'s effect has. The first is the only event that proves the command landed; the
	   second is because the override is per-song, so a draft carried across a song change would show the previous
	   song's level against the new song's default. */
	expect(queuePage).toContain(
		'if (guideDraft !== null && (guideServerPct === guideDraft || !nowEntry)) guideDraft = null;'
	);
	// The draft is written by the send module's verdict, never by the input handler directly — that is what makes
	// a dropped command clear it. guide-send.test.ts drives the verdict itself.
	expect(queuePage).toContain('onDraft: (pct) => (guideDraft = pct)');
	expect(queuePage).toContain('oninput={(pct) => guideSend.input(pct)}');
	expect(queuePage).toContain('oncommit={(pct) => guideSend.commit(pct)}');
});

test('the ± keycaps still refuse to move the draft on a dropped command', () => {
	// The site that already had the treatment, pinned so the pattern cannot be undone at one of the five.
	expect(queuePage).toContain("if (!room.command({ cmd: 'key', semitones: next })) return;");
});

test('NO call site of room.command discards the boolean', () => {
	/* The exhaustive arm, and the reason this file is worth having. Every `room.command(` under src/ must sit
	   inside something that reads its result: an `if`, a `return`, or an arrow body handed to `createGuideSend`.
	   A bare statement call is the defect, and it is the shape a sixth control added later would arrive in. */
	const sites = [...layout.matchAll(/room\.command\(/g), ...queuePage.matchAll(/room\.command\(/g)];
	// Three in the layout's helper and the route (one helper call, ±key, the guide send), so the count is a floor
	// on the scan having found anything at all rather than a claim about the total.
	expect(sites.length).toBeGreaterThanOrEqual(3);

	/* AN ALLOW-LIST, NOT "anything but a bare statement", and that distinction is a bug this test caught in its
	   own first draft. A permissive `=> room.command(` arm passed `onskip={() => room.command({cmd:'skip'})}` —
	   which is the ORIGINAL DEFECT verbatim, since the prop's type is `() => void` and the returned boolean goes
	   nowhere. So the only arrow body admitted is the send adapter handed to `createGuideSend`, whose caller
	   does consume it. A new site must either test the boolean here or add its own arm with its own reason. */
	const CONSUMES = /(?:if \(!?|return |send: \(pct\) => )$/;
	for (const source of [layout, queuePage]) {
		for (const m of source.matchAll(/(.*)room\.command\(/g)) {
			expect(m[1]!).toMatch(CONSUMES);
		}
	}
});
