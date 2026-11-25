import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { at } from '$test';

/*
 * guard: every `RoomLink.command` call site reads the boolean it returns.
 *
 * `command` reports whether the frame reached the wire, and a PLAYER command is NOT resent on resync the way a
 * queue add is (`QueueStore.resendPending` has no counterpart on that path), so a dropped one is simply lost.
 * The defect: all five sites discarded the boolean, the only report was a
 * `console.warn`, and two of the five held an optimistic value — so the ± keycap showed a shift the server had
 * never heard and the guide slider followed the finger through a drag the room never heard and then sprang back.
 *
 * WHY A SOURCE SCAN. These are five lines of wiring inside `.svelte` files, and the component-mount harness is
 * gone (bunfig.toml records why) — a browser can see the control move but not whether the boolean was consulted,
 * and the window where a send fails while the socket still reads connected is not reachable from a spec. What is
 * here is the route's wiring, plus the three transport buttons, which hold no optimistic state at all and so have
 * nothing testable except who they call.
 *
 * The exhaustiveness test at the bottom is the one that matters most: it is what makes a SIXTH call site, added
 * later and discarding the boolean again, red rather than invisible.
 */

const layout = readFileSync(at('src/routes/+layout.svelte'), 'utf8');
const queuePage = readFileSync(at('src/routes/queue/+page.svelte'), 'utf8');

/* THE WHOLE TREE, because the two files above are where the call sites happen to be TODAY and the exhaustiveness
   arm at the bottom claims something about tomorrow. Reading only those two was a hole a verifier walked
   through: a bare `room.command({ cmd: 'skip' });` pasted into `src/routes/+page.svelte` left this suite green,
   and that is one of five files importing the singleton. Directories have no matching extension, so the filter
   is also what keeps `readFileSync` off them. */
const SRC = readdirSync(at('src'), { recursive: true, encoding: 'utf8' })
	.filter((rel) => /\.(svelte|ts)$/.test(rel))
	.map((rel) => ({ rel: rel.replaceAll('\\', '/'), body: readFileSync(at('src', rel), 'utf8') }));

test('the transport buttons go through one reporting helper, not three bare sends', () => {
	// One helper, because three copies of the same `if (!room.command(...))` is how two of them keep the old copy.
	expect(layout).toContain('function transport(command: PlayerCommand): void {');
	expect(layout).toContain('if (room.command(command)) return;');
	expect(layout).toContain("restart: () => targeted('restart'),");
	expect(layout).toContain("togglePlay: () => transport({ cmd: isPlaying ? 'pause' : 'play' }),");
	expect(layout).toContain("skip: () => targeted('skip')");
	expect(layout).toContain("onplay={() => transport({ cmd: 'play' })}");
	expect(layout).toContain('if (entryId) transport({ cmd, entryId });');
	// The keys on /queue's Now card reach the helper through the context, never through a bare send.
	expect(queuePage).toContain('onclick={tp.restart}');
	expect(queuePage).toContain('onclick={tp.togglePlay}');
	expect(queuePage).toContain('onclick={tp.skip}');
});

test('the notice carries a stable id, so a mash is one notice rather than a tower of them', () => {
	/* Sonner keys toasts by `id`: a create against an id already on screen UPDATES that toast (and sets
	   `updated`, which resets its auto-close timer) instead of pushing another. Without the id, a guest tapping
	   skip five times at a dead socket gets five stacked error toasts over the dock. */
	expect(layout).toContain("id: 'transport-dropped',");
	expect(layout).toContain('duration: 4000,');
	/* `toast.error`, not `toast.warning`, and the severity split FRONTEND.md states is the reason: --warn is for
	   a transient failure and the dock's bar is correctly one, because the socket self-heals on the next backoff
	   tick. This does not — the command is gone and only the guest can reissue it. (The assertion is on the
	   CHANNEL, which is the decision; sonner paints its error toast on its own surface rather than on --danger.)
	   4000ms matches /queue's own error sink, so two notices on one surface do not linger for different spans. */
	expect(layout).toContain('toast.error(message, {');
	expect(layout).toContain('transportNotice("Not connected — the TV didn\'t hear that.");');
});

test('the dock keeps its own offline cue, which answers the OTHER question', () => {
	/* The per-tap notice does not replace the cue and must not be read as making it redundant: the cue is up for
	   the whole outage and says the link is down, the notice says one specific command was lost. Deleting either
	   leaves a real gap, so both are pinned. Since proposal 13 the cue is the strip's title slot, not a row. */
	// The link decides when the link is down (`RoomLink.offline`, room-connect.test.ts); the layout only shows it.
	expect(layout).toContain('offline = room.offline;');
	expect(layout).toContain('connected={!offline}');
	const strip = readFileSync(at('src/lib/ui/NowPlayingStrip.svelte'), 'utf8');
	expect(strip).toContain('{#if !connected}');
	expect(strip).toContain('Reconnecting…');
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
	// `--youre-up-h` is 0 except while the "You're up" sheet is up, when the toast stacks above it instead of on it.
	expect(layout).toContain("offset={{ bottom: 'calc(var(--dock-h, 0px) + var(--youre-up-h, 0px) + 24px)' }}");
	// The sides are named too, but as the sheet's gutter token, never the bottom's calc: see the scalar trap above.
	expect(layout).toContain("bottom: 'calc(var(--dock-h, 0px) + var(--youre-up-h, 0px) + 16px)',");
	expect(layout).toContain("left: 'var(--sheet-gutter)',");
	expect(layout).toContain("right: 'var(--sheet-gutter)'");
	// ...and the sheet reads the same token, so the two edges move together (a literal 16px would only match today).
	const sheet = readFileSync(at('src/lib/components/YoureUp.svelte'), 'utf8');
	expect(sheet).toContain('inset-inline: var(--sheet-gutter);');
	expect(sheet).not.toMatch(/inset-inline:\s*\d/);
});

test("the guide pick hands the command's boolean back, so a dropped pick drops at once", () => {
	/* Guide is Off / Low / Full on /queue (redesign step 5b). GuideSegments drops its pick when `onpick` returns false,
	   so the route must return what `room.command` said, and name the song so a pick after a skip is dropped as stale. */
	expect(queuePage).toContain("return room.command({ cmd: 'guide', level, entryId: nowEntry.id });");
	expect(queuePage).toContain('if (spotLive) return guidePick(level);');
	// The key draft still resets on a song change, keyed on the entry ID: a skip never passes through null.
	expect(queuePage).not.toContain('|| !nowEntry)');
	expect(queuePage).toContain('if (id === draftsFor) return;');
});

test('the guide slider is CONTROLLED, so a refused command cannot leave the thumb out there', () => {
	/* THE OTHER HALF OF THE SAME FINDING, and the half that shipped once already. Holding the draft back is not
	   enough on its own: bits-ui keeps its own copy of `value` and reads every thumb position, the filled range
	   and `aria-valuenow` out of it, so a plain `value={shown}` let all three advance on a command the room never
	   heard — measured offline against a room at 0%, `aria-valuenow` reached 95 and the thumb 92% of the track
	   while the readout still said "Off", and it was STILL THERE after the socket came back.
	   A `bind:` cannot travel through a spread, which is why FieldSlider has to declare `value` rather than let it
	   ride `...rest`; both halves are pinned because either one alone restores the defect. */
	const guidingTrack = readFileSync(at('src/lib/components/GuidingTrack.svelte'), 'utf8');
	const fieldSlider = readFileSync(at('src/lib/ui/FieldSlider.svelte'), 'utf8');
	expect(guidingTrack).toContain('bind:value={level, requestLevel}');
	// The getter returns the caller's authority and NOTHING else — a mirror in local state is the defect wearing a
	// binding.
	expect(guidingTrack).toMatch(/function level\(\): number \{\s*return shown;\s*\}/);
	/* THE NEGATIVE IS SCOPED TO THE ELEMENT, not the file, and that is not fussiness: a file-wide
	   `not.toContain('value={shown}')` went red on the COMMENT above the binding, which names the defective
	   spelling in order to explain it. A negative that forbids writing down what was fixed buys a passing test by
	   deleting the account — the same trap the guideDraft test below records. So the slice is the one element's
	   attribute list, from `<FieldSlider` to the `/>` that closes it. */
	const el = guidingTrack.slice(
		guidingTrack.indexOf('<FieldSlider'),
		guidingTrack.indexOf('/>', guidingTrack.indexOf('<FieldSlider'))
	);
	expect(el).toContain('bind:value={level, requestLevel}');
	expect(el).not.toContain('value={shown}');
	// A spread would hide a `value` the slice cannot see, which would make the negative above vacuous.
	expect(el).not.toContain('{...');
	expect(fieldSlider).toContain('value = $bindable()');
	expect(fieldSlider).toContain('bind:value={value as never}');
});

test('the ± keycaps still refuse to move the draft on a dropped command', () => {
	// The site that already had the treatment, pinned so the pattern cannot be undone at one of the five.
	expect(queuePage).toContain("if (!room.command({ cmd: 'key', semitones: next, entryId: nowEntry.id })) return;");
});

test('the scan this file rests on reaches every file that can host a call site', () => {
	/* ANTI-VACUITY, asserted ahead of the arm that uses it: an exhaustiveness claim is only worth what its file
	   list is worth, and this one was worth two files. The importers are DERIVED rather than listed, so a sixth
	   one needs no edit here; what is pinned is that the scan sees all of them and that it sees the specific file
	   the old two-file version was blind to. */
	const importers = SRC.filter((f) => /import \{ room \} from '\$lib\/stores\/room'/.test(f.body)).map((f) => f.rel);
	expect(importers).toContain('routes/+page.svelte');
	expect(importers).toContain('routes/+layout.svelte');
	expect(importers).toContain('routes/queue/+page.svelte');
	expect(importers).toContain('routes/library/+page.svelte');
	expect(importers).toContain('routes/song/[mediaId]/+page.svelte');
	// A floor, not the total: a sixth importer is fine, a scan that found four is a broken scan.
	expect(importers.length).toBeGreaterThanOrEqual(5);
});

test('NO call site of room.command discards the boolean, anywhere under src/', () => {
	/* The exhaustive arm, and the reason this file is worth having. Every `.command(` under src/ must be on the
	   room singleton AND must sit inside something that reads its result: an `if`, a `return`, or the send
	   adapter handed to `createGuideSend`. A bare statement call is the defect, and it is the shape a sixth
	   control added later would arrive in.
	   SCANNED FOR `.command(` RATHER THAN `room.command(` so that an aliased receiver (`const r = room;
	   r.command(…)`) is red rather than unseen — it would be a call site this guard could not reason about, so it
	   has to be argued rather than smuggled in. The module that DEFINES the method is skipped: its own
	   declaration is not a call site, and nothing there is spelled with a leading dot today anyway. */
	const DEFINITION = 'lib/stores/room.ts';
	/* AN ALLOW-LIST, NOT "anything but a bare statement", and that distinction is a bug this test caught in its
	   own first draft. A permissive `=> room.command(` arm passed `onskip={() => room.command({cmd:'skip'})}` —
	   which is the ORIGINAL DEFECT verbatim, since the prop's type is `() => void` and the returned boolean goes
	   nowhere. So the only arrow body admitted is the send adapter handed to `createGuideSend`, whose caller
	   does consume it. A new site must either test the boolean here or add its own arm with its own reason. */
	const CONSUMES = /(?:if \(!?|return |send: \(pct\) => )$/;
	const offenders: string[] = [];
	let sites = 0;
	for (const { rel, body } of SRC) {
		if (rel === DEFINITION) continue;
		for (const m of body.matchAll(/(.*)\.command\(/g)) {
			sites += 1;
			const lead = m[1]!;
			if (!lead.endsWith('room')) {
				offenders.push(`${rel}: receiver is not the room singleton — ${m[0]!.trim()}`);
				continue;
			}
			if (!CONSUMES.test(lead.slice(0, -'room'.length))) {
				offenders.push(`${rel}: result discarded — ${m[0]!.trim()}`);
			}
		}
	}
	expect(offenders).toEqual([]);
	// Three today: the layout's one `transport` helper, ±key, and the guide send. A floor on the scan having
	// found anything at all rather than a claim about the total — a fourth well-formed site is not a failure.
	expect(sites).toBeGreaterThanOrEqual(3);
});
