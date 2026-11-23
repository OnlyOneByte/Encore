<script lang="ts">
	import { untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { SINGER_COLORS } from '$lib/contract';
	import { overallProcessPct } from '$lib/process-progress';
	import Icon from '$lib/ui/Icon.svelte';
	import type { MediaStatus } from '$lib/contract';
	import { retryHoldAfter, type QueueCardKind } from '$lib/readiness';
	import {
		processReadout,
		processStageLabel,
		RETRYING_LABEL,
		STALLED_TURN_LABEL
	} from '$lib/phrasing/process-phrasing';
	import { Progress } from '$lib/components/ui/progress';
	import * as Item from '$lib/components/ui/item';
	import { pickAnotherName, removeTurnName, reorderName, tryAgainName } from '$lib/phrasing/row-action-names';
	interface Props {
		/** WHICH CARD THIS IS, decided by `queueCardKind` at the route and never re-derived here from `status` — the
		 * readiness classifier is the only thing that may answer "can the rotation ever play this entry", and a
		 * second answer computed from a live status is exactly the disagreement it exists to prevent. Three of the
		 * four kinds reach this component; `plain` is QueueRow's. */
		kind: Exclude<QueueCardKind, 'plain'>;
		// Both absent when the card renders OUTSIDE the rotation list, where there is no slot or singer to attribute to.
		seq?: number;
		title: string;
		singerName?: string;
		singerColor?: string;
		/** The singer who queued this is in the room but unreachable (locked phone, pocket). */
		singerAway?: boolean;
		/** The optimistic add is unconfirmed. This state has to exist HERE, not only on QueueRow: the primary Sing flow
		 * produces a PROCESSING entry, so this card is what renders during an add, and the unconfirmed state would
		 * otherwise be invisible on the exact path that creates it. A KIND, never a boolean: a pending REORDER must not
		 * announce that it is "adding". */
		pending?: 'add' | 'move' | null;
		/** The live stage — queued|downloading|separating|aligning — read ONLY when `kind === 'processing'`.
		 *
		 * OPTIONAL BECAUSE THE GAP IS REAL, not to give the caller a shortcut: the catalog can say a media is
		 * processing while this phone holds no live status for it (`refreshLibrary()` sets `libraryFailed` and
		 * returns while the catalog still arrives via `queue:sync`), and that row is a cooking turn that must still
		 * draw a bar. `queued` is then the honest stand-in — SongRow's own rule for the same gap, "the LEAST
		 * COMMITTAL in-flight value: naming a step would print a guess as fact". A `failed` or `stalled` card reads
		 * neither this nor `pct`, which is why the route may stop inventing one. */
		status?: MediaStatus;
		pct?: number;
		/** Seconds until the song is ready, from core's history of this box (`server/jobs/eta.ts`). Absent when
		 * there is none to base it on, and then the card says no time at all. */
		etaSec?: number;
		/** The ROOM's maker verdict (`waitingTurns(…).noMaker`), the one the TV and the strips read. A stalled card says
		 * it can't be made only when no maker is here; with one, it reads as the failed card does, so a phone that missed
		 * the failure (asleep, or joined later) says what the phones that heard it say. */
		noMaker?: boolean;
		// A processing song is still a QUEUE ENTRY, so it gets the same controls a ready row does — a minutes-long
		// process is a long time to be stuck on a mis-tap. All absent outside the rotation, where there is no slot.
		onremove?: () => void;
		/** Ask for the karaoke again. Present only on a STALLED or FAILED card, where the turn exists and nothing
		 * is making its karaoke — `processAndQueue`'s `hasQueuedTurn` branch, so the turn is kept rather than re-added. */
		onretry?: () => void;
		/** Where to choose a different song for THIS turn, keeping its place — a link, because it is a navigation. The
		 * singer's own dead cards only: it takes their pick away, which is the remove gate's reason for ownership too. */
		pickAnotherHref?: string;
		reorderable?: boolean;
		/** The caller passes `gripVisible()` from `$lib/reorder-mode`, never a raw boolean. This card is draggable in
		 * the same list as the uniform rows: `liveSortTarget` counts crossings against every row's measured CENTRE
		 * rather than dividing by one height, which is what makes a mixed-height list exact in both directions. */
		grip?: boolean;
		/** The queue entry's id, published on the grip as `data-grip` so focus can be re-found after a move. */
		gripId?: string;
		ongripdown?: (e: PointerEvent) => void;
		/** This is the card being dragged. Its offset is `dragY`, applied as a transform. */
		moving?: boolean;
		/** Live pointer offset in px for the moving card. CSS-var driven — see the `.moving` rule. */
		dragY?: number;
		/** A keyboard step from the grip: -1 for Arrow Up, +1 for Arrow Down — the non-drag path. */
		onnudge?: (delta: number) => void;
		/** In ROWS rather than pixels: the pixel height is the page's business, and a component taking px would need
		 * the same measurement twice. */
		shift?: -1 | 0 | 1;
		/** The list's hold, as QueueRow's: `dy` px from where the card was drawn before a patch moved it. */
		hold?: { dy: number; turn: 'a' | 'b' };
	}
	let {
		kind,
		seq,
		title,
		singerName,
		singerColor = SINGER_COLORS[0],
		singerAway = false,
		pending = null,
		status,
		pct = 0,
		etaSec,
		noMaker = false,
		onremove,
		onretry,
		pickAnotherHref,
		reorderable = false,
		grip = false,
		gripId,
		ongripdown,
		onnudge,
		moving = false,
		dragY = 0,
		shift = 0,
		hold
	}: Props = $props();

	/* A DEAD CARD'S LINE FOLLOWS THE ROOM, never its kind (ruling 38). `failed` (a process ran and died) and
	   `stalled` (nothing is making it) are the same stuck turn to a guest: with no maker here it can't be made, so
	   both say STALLED_TURN_LABEL, as the strip and the TV do; with one, a Try again will work, so both say the
	   failed card's line. A phone that missed the failure, and one that heard it, then read the same. The pct is
	   shown separately in the stage row below, so the line itself omits it. */
	const dead = $derived(kind === 'stalled' || kind === 'failed');
	/* TRY AGAIN ANSWERS AT ONCE. With no maker the server's reply is the SAME stalled verdict within a frame, so
	   the card never changed and the tap read as dead — an invitation to tap twice more. So the tap itself swaps
	   the line to "Trying again…" for RETRY_ACK_MS, a flat hold that a VERDICT alone cuts short: a fresh `failed`
	   or `ready` (`retryHoldAfter`). A stage never does, because the server synthesises one for a new job before any
	   worker has it. Then the card follows the server.
	   shortcut: a fixed hold, not a server ack; upgrade if /api/process ever returns its verdict to the caller. */
	const RETRY_ACK_MS = 1500;
	let retrying = $state(false);
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let heldOver: MediaStatus | undefined;
	/* THE BUTTON ROW OUTLIVES THE TAP'S OWN EFFECT. The tap marks the song `queued` at once, the card turns
	   `processing`, and the route stops passing `onretry` / `pickAnotherHref` for a processing card — so the row
	   vanished for the hold and came back, and the card shrank a row and grew again. The row is kept, disabled,
	   for as long as the hold lasts; what the card does after it is the route's call again. */
	let heldPick: string | undefined;
	const showRetry = $derived(!!onretry || retrying);
	const pickHref = $derived(pickAnotherHref ?? (retrying ? heldPick : undefined));
	function retry() {
		retrying = true;
		heldPick = pickAnotherHref;
		heldOver = status;
		clearTimeout(retryTimer);
		retryTimer = setTimeout(() => (retrying = false), RETRY_ACK_MS);
		onretry?.();
	}
	$effect(() => {
		if (!retrying) return;
		const next = retryHoldAfter(heldOver, status);
		if (next !== null) heldOver = next;
		else {
			retrying = false;
			clearTimeout(retryTimer);
		}
	});
	$effect(() => () => clearTimeout(retryTimer));

	const stageLabel = $derived(
		retrying
			? RETRYING_LABEL
			: dead
				? noMaker
					? STALLED_TURN_LABEL
					: processStageLabel('failed')
				: processStageLabel(status ?? 'queued')
	);
	// One expression for both unconfirmed states, so a pending reorder cannot re-borrow the add path's word.
	const pendingLabel = $derived(pending === 'move' ? 'moving…' : 'adding…');

	/** Which way the position number just moved — same shape and same three constraints as QueueRow's, so see the
	 * note there. `seq` is OPTIONAL here (an unnumbered job shows a sparkle), so an absent number is not a
	 * direction: it seeds the record and writes nothing. */
	let seqDir = $state(0);
	let prevSeq: number | undefined;
	$effect.pre(() => {
		if (seq === undefined || prevSeq === undefined || seq === prevSeq) {
			prevSeq = seq;
			return;
		}
		seqDir = seq > prevSeq ? 1 : -1;
		prevSeq = seq;
	});
	/* TWO NON-FLIGHT KINDS, and both reach this card because the singer's own queue slot is the only place that can
	   say so. `failed` is a process that RAN AND DIED; `stalled` is a turn with no process at all. Neither draws a
	   bar or a sparkle — a bar near 0 reads as slow rather than stopped — and they differ in what they are entitled
	   to claim, which is why they are two kinds and not one: see the --danger/--warn note in the styles below.
	   A RETRY LIVES HERE NOW, on the stalled kind only (`onretry`), alongside SongRow's — which is reachable only
	   from a search result, so recovering a stranded turn meant finding the song again first.
	   THE LOOK FOLLOWS THE WORDS, so one line never wears two tones on two phones: the danger look goes with
	   "Couldn't make karaoke" (a maker is here and a Try again will work), the warn look with "Can't make this one
	   right now" (no maker).
	   While a Try again is being acknowledged the card wears the stalled look (warn ink, no bar, no sparkle),
	   whatever its kind: it is not "broken" in that moment and nothing has been measured yet, it is trying. */
	const failed = $derived(dead && !noMaker && !retrying);
	const stalled = $derived((dead && noMaker) || retrying);
	const inFlight = $derived(kind === 'processing' && !retrying);
	// `pct` is the worker's PER-STEP 0-100; the bar must show OVERALL completion, or every step reaching 100% fills
	// the whole bar while later milestones have not started. Rounded only for the readout.
	const overall = $derived(overallProcessPct(status ?? 'queued', pct));

	/* THE STAGE THIS CARD WAS BORN IN, captured once at init and never again — ported from SongRow, whose own note
	   carries the measurement that forced it: /library mounted one polite region per rendered row and a
	   MutationObserver armed before the tab tap counted 63 `role=status` INSERTIONS against 3 removals, every one
	   of them a dynamic insertion AT may speak. This card had NO such guard, and it did not need one while every
	   non-plain kind required a live status: /queue was measured at 1 region and 2 insertions. The stalled arm is
	   what makes it need one — it turns every stranded turn in the room into a mounted region reading one sentence.
	   DRIVEN WITH THIS GUARD IN PLACE, 390x844 against the owner's library copy, MutationObserver armed before the
	   tab tap: a /queue arrival rendering 99 stalled cards inserted 3 `role=status` regions and removed 3, and the
	   page holds 1 afterwards — the route's own queue announcer. Every card contributed none.
	   WHAT SURVIVES is the thing worth announcing: a card that CHANGES stage still speaks, and the retry is exactly
	   such a change (stalled → "Making karaoke…" on the same component instance, because the route's branch and its
	   `(e.id)` key both hold).
	   `untrack` rather than a bare read, this tree's idiom in exactly this position (SongRow, TvPlayer,
	   settings/you): a bare read of a rune outside an effect raises `state_referenced_locally`, which
	   `bun run check` surfaces. MUST STAY BELOW `stageLabel`, which it reads — `$derived` is lazy at runtime, but
	   the checker reports a block-scoped use before declaration. */
	const bornStage = untrack(() => stageLabel);
</script>

<!-- Item.Root supplies the row grammar through its `child` snippet, so this file keeps the row ELEMENT: a `class:`
	directive is not valid on a component and a class handed to one is scoped to the caller. -->
<Item.Root variant="bare" size="bare">
	{#snippet child({ props })}
		<div
			{...props}
			class={['qrow', 'proc', 'card', 'list-row', { pending, failed, stalled, moving, shifted: shift !== 0 }]}
			data-hold={hold?.turn}
			style="--drag-y:{dragY}px; --row-shift:{shift}; --hold-from:{hold?.dy ?? 0}px"
		>
			<!-- The digit rolls on a position change exactly as QueueRow's does: the two kinds share ONE list, and a drag
					that rolled one and jumped the other reads as broken. Keyed on the number, so a change swaps the element. -->
			<Item.Media>
				<!-- THE GRIP LEADS THE ROW, deliberately identical to QueueRow's: these two kinds sit in ONE list, and a card
						you cannot pick up beside rows you can reads as broken rather than different. An unconfirmed move is DECLINED IN
						THE HANDLERS, not by withholding the button — same defect and same fix as QueueRow's, see the note there. -->
				{#if grip}
					<Button
						variant="ghost"
						size="icon"
						press="grab"
						aria-label={reorderName(title, singerName)}
						aria-keyshortcuts="ArrowUp ArrowDown"
						aria-disabled={pending ? 'true' : undefined}
						data-grip={gripId}
						onpointerdown={(e) => {
							if (pending) return;
							ongripdown?.(e);
						}}
						onkeydown={(e) => {
							if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
							// The list owns what a step means; this only stops the page scrolling under the guest while they use it.
							e.preventDefault();
							if (pending) return;
							onnudge?.(e.key === 'ArrowUp' ? -1 : 1);
						}}><Icon name="grip" /></Button
					>
				{/if}
				<div class="seq" style="--seq-dir:{seqDir}">
					{#if seq}{#key seq}<span class="n">{seq}</span>{/key}{:else}<Icon name="sparkle" />{/if}
				</div></Item.Media
			>
			<Item.Content>
				<!-- THE SPARKLE MUST STAY A SIBLING of `.t`, never nested inside it: `.t` carries `overflow: hidden`, which makes
						it a scroll container, so a mark inside is clipped off-box exactly when the title is long enough to need the
						ellipsis — precisely the state the mark exists to announce. -->
				<div class="title-line">
					<span class="t">{title}</span>
					<!-- THE SPARKLE MEANS "SOMETHING IS HAPPENING TO THIS SONG", so only the in-flight kind may wear it.
							It was gated on `!failed` while those were the only two kinds; a stalled turn is the case where that
							negative becomes a lie, since nothing is being made for it at all. -->
					{#if inFlight}<span class="sparkle"><Icon name="sparkle" /></span>{/if}
				</div>
				{#if singerName}
					<div class="who">
						<!-- Same away marker as QueueRow: a process outlives its owner's attention span. THIS LINE NAMES THE SINGER AND
								NOTHING ELSE — process state belongs to the stage row below it, from the shared phrasing source. -->
						<i class={['singer-dot', { dim: singerAway }]} style="--singer:{singerColor}"></i>
						{singerName}{#if singerAway}<span class="away">· away</span>{/if}{#if pending}{' · '}<span class="adding"
								>{pendingLabel}</span
							>{/if}
					</div>
				{/if}
			</Item.Content>
			{#if !pending && (onremove || reorderable)}
				<Item.Actions data-align="start">
					<!-- Reordering lives on the GRIP above, so this cluster holds REMOVE, the one control that ends the TURN.
							`reorderable` only WIDENS the gate — it contributes nothing of its own — so a card the route says may
							move but that is not the guest's to remove renders this cluster empty. The two ways FORWARD from a
							dead card are words, in their own row below, because a guest has to read them to choose. -->
					{#if onremove}
						<Button
							variant="outline"
							size="icon"
							press="accent2"
							aria-label={removeTurnName(title)}
							data-testid="queue-remove"
							onclick={() => onremove?.()}><Icon name="close" /></Button
						>
					{/if}
				</Item.Actions>
			{/if}
			<!-- Keyed on the line, so a change of stage (a Try again landing, the making state arriving) pops in with
					the app's `pop` keyframe at --motion-base, dropped under reduced motion. Never on mount: a list of
					stranded turns does not all bounce on arrival. -->
			{#key stageLabel}<div class="progress" class:stage-in={stageLabel !== bornStage}>
					{#if failed}
						<!-- No bar for a dead process: a bar stuck near 0 reads as stalled rather than failed, so the tinted stage
							line carries the state on its own. -->
						<div class="stage bad"><span>{stageLabel}</span></div>
					{:else if stalled}
						<!-- No bar and no percentage, for a stronger reason than the failed card's: there is no process to have
							made progress, so ANY figure here would be invented. The line keeps `.stage`'s own --warn ink — see
							the styles for why this card may not take the danger family. -->
						<div class="stage"><span>{stageLabel}</span></div>
					{:else}
						<div class="bar-slot"><Progress value={overall} aria-label="Process progress" /></div>
						<div class="stage"><span>{stageLabel}</span><span>{processReadout(overall, pct, etaSec)}</span></div>
					{/if}
				</div>{/key}
			{#if !pending && (showRetry || pickHref)}
				<!-- RETRY IS UNGATED BY OWNERSHIP, unlike remove and pick-another, and that asymmetry is the point: remove
						and pick-another take someone's pick away, a retry takes nothing and /api/process is already callable by
						any joined singer for any song from the Sing tab. In the owner's own library copy every stranded turn
						belongs to a singer who is `· away`, so an ownership gate would make all 89 unfixable from any phone in
						the room. The blast radius is bounded where it already was: `processState`'s over-limit arm caps
						in-flight processes per singer. -->
				<div class="next">
					{#if showRetry}
						<Button
							size="tap"
							variant="secondary"
							data-testid="card-retry"
							aria-label={tryAgainName(title)}
							title="Make the karaoke again — you keep your spot"
							disabled={retrying}
							onclick={retry}>Try again</Button
						>
					{/if}
					{#if pickHref}
						<!-- Held with Try again: the Button drops a disabled link's href and marks it aria-disabled. -->
						<Button
							size="tap"
							variant="secondary"
							data-testid="card-pick-another"
							aria-label={pickAnotherName(title)}
							title="Pick another song — you keep your spot"
							disabled={retrying}
							href={pickHref}>Pick another</Button
						>
					{/if}
				</div>
			{/if}
		</div>
	{/snippet}
</Item.Root>

<!-- THE STAGE TRANSITION IS THE ANNOUNCEMENT, NEVER THE PERCENTAGE. The visible row above carried `aria-live` over text
	containing the pct, and the hub rebroadcasts `media:status` on every worker progress report with no throttle — so a
	guest waiting on three songs got several hundred polite announcements, starving the regions that matter (the queue
	announcer and the reorder notes). `stageLabel` is pct-free, so this speaks once per real transition. The bar keeps
	`role="progressbar"` with its value, which AT reads ON DEMAND instead of being pushed.
	AND ONLY A CHANGE OUT OF `bornStage` GETS A REGION AT ALL, which is SongRow's rule arriving here — see the note on
	`bornStage` for the measurement and for what it deliberately gives up (a card that MOUNTS already stalled or
	already failed announces nothing; its visible line still says so, and a stall the guest did not watch happen is
	not news worth interrupting them with). The retry still speaks, because that is a real transition. -->
{#if stageLabel && stageLabel !== bornStage}
	<div class="vh" role="status">{stageLabel}</div>
{/if}

<style>
	/* `.seq`, `.t` and `.who` must STAY in this file, because they declare COLOUR and a contrast question about this row
	   has to be answerable from here. `.list-row` gives the padding, margin and gap; this card overrides the
	   display to a two-row grid, so the actions cluster cannot eat into the bar. */
	.qrow.proc {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: flex-start;
		row-gap: 0;
	}
	/* Spans first column through last whether or not the actions column rendered — load-bearing. */
	.progress {
		grid-column: 1 / -1;
	}
	/* The app's `pop` (app.css), timed by token rather than `.pop-in`'s literal, so the motion check reads it. */
	@media (prefers-reduced-motion: no-preference) {
		.progress.stage-in {
			animation: pop var(--motion-base) cubic-bezier(0.2, 0.9, 0.3, 1.3);
		}
	}
	.next {
		grid-column: 1 / -1;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}
	.proc {
		background: linear-gradient(var(--card), var(--card-tint));
		border-color: var(--line-tint);
	}
	/* A dead process: the border reads as broken before the text does, matching the failure chip the search row
	   shows for the same media, and the stage line takes the danger ink instead of the in-flight --warn. */
	.proc.failed {
		border-color: var(--danger-line);
	}
	.stage.bad {
		color: var(--danger-ink);
	}
	/* A NO-MAKER DEAD CARD TAKES THE WARN FAMILY, NOT THE DANGER ONE, and docs/FRONTEND.md's token rule is what
	   decides it rather than taste: --danger means a failure that WILL NOT self-heal, --warn one that may. With no
	   maker here the CAUSE can clear by itself (a maker connects), so the card is --warn whatever its kind; the turn
	   itself still needs a Try again, and when a maker joins the card turns to "Couldn't make karaoke" and waits for
	   that tap. With a maker, nothing will clear on its own, so every dead card takes `.proc.failed`, and a phone that
	   missed the failure wears the same tone as one that heard it. The ink needs no rule at all: `.stage` is already --warn,
	   so only the border is stated.
	   SAME SPECIFICITY GAME AS `.proc.failed`: two classes, so it wins over `.pending`'s one-class border
	   deliberately, and an unconfirmed stalled card keeps the pending SURFACE under a warn edge. */
	.proc.stalled {
		border-color: var(--warn-line);
	}
	/* The unconfirmed state is a warn tint on the CARD SURFACE, never a subtree opacity: an alpha here composites the
	   stage line to 3.76:1 against a 4.5:1 floor and the singer dot to 2.57:1, and the value that clears AA is
	   indistinguishable from 1.0. MUST STAY AFTER `.proc` so a pending card overrides its processing gradient;
	   `.proc.failed`'s border wins on specificity, deliberately. Do not restore the opacity. */
	.pending {
		background: var(--warn-bg);
		border-color: var(--warn-line);
	}
	.adding {
		color: var(--warn);
	}
	.seq {
		width: 26px;
		height: 26px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-size: var(--ph-text-sm);
		font-weight: 700;
		background: var(--card2);
		color: var(--ink-dim);
		flex: 0 0 auto;
		/* The bubble is the roll's window — the arriving digit is clipped by the circle on its way in. */
		overflow: hidden;
	}
	/* Byte-identical to QueueRow's roll: one list, one behaviour. `from` only, so the landing state is the
	   element's own, and a `--seq-dir` of 0 degrades it to a fade. */
	@media (prefers-reduced-motion: no-preference) {
		.seq .n {
			animation: seq-roll 180ms cubic-bezier(0.32, 0.72, 0, 1);
		}
		@keyframes seq-roll {
			from {
				transform: translateY(calc(var(--seq-dir, 0) * 110%));
				opacity: 0;
			}
		}
	}
	/* `.t` is byte-identical to QueueRow's deliberately: the two kinds sit in the SAME list, so a long title that grew
	   THIS card while the row beside it ellipsised reads as a layout bug. `overflow: hidden` makes the box a scroll
	   container, whose inline min-content contribution is 0 — which stops the `1fr` track being forced wide. */
	.title-line {
		display: flex;
		align-items: baseline;
		min-width: 0;
	}
	.t {
		flex: 0 1 auto;
		min-width: 0;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Spacing via margin, matching SongRow. `flex: 0 0 auto` is load-bearing: as a flex sibling of a shrinking title,
	   the mark is otherwise the thing that shrinks. */
	.sparkle {
		flex: 0 0 auto;
		color: var(--warn);
		display: inline-grid;
		place-items: center;
		margin-left: 5px;
	}
	.who {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
		margin-top: var(--space-3xs);
	}
	.who i.dim {
		opacity: 0.5;
	}
	.who .away {
		color: var(--warn);
		margin-left: 0.35em;
	}
	/* The singer dot's `flex: 0 0 auto is load-bearing` on this card, and the declaration itself lives in app.css's
	   shared `.singer-dot` rule. `.who` is a flex container and the dot an empty item whose automatic minimum size is
	   0, so it is the item that gives up width first: with the actions cluster rendered `.who` narrows to roughly
	   134px, and an UNBROKEN name at the profile maxlength cannot wrap, so the dot absorbs the whole deficit and
	   collapses to 0px — and that dot is the only thing telling two singers apart besides the name. The gallery
	   carries an unbroken maxlength fixture so the case stays eyes-on. */
	/* Spacing above the bar stays here: it is this card's layout, not the bar's own metric. */
	.bar-slot {
		margin-top: 9px;
	}
	.stage {
		display: flex;
		justify-content: space-between;
		font-size: var(--ph-text-xs);
		color: var(--warn);
		margin-top: 7px;
	}
	/* THE DRAGGED CARD FOLLOWS THE FINGER — byte for byte QueueRow's `.moving`, because the two kinds are dragged in
	   ONE list by one gesture. No transition and no keyframe, which is what makes reduced motion hold by
	   construction; `pointer-events: none`, or a card translated under the finger answers every hit-test. */
	.moving {
		transform: translateY(var(--drag-y, 0px));
		position: relative;
		z-index: var(--z-row-lifted);
		border-color: var(--accent);
		pointer-events: none;
	}
	/* The live sort, in the same terms QueueRow uses: `--row-shift` is a COUNT of rows and `--row-h` the one
	   height the page measured at press time, so pixels stay out of the markup. The transition is GATED,
	   unlike `.moving`, because it is the one interpolated movement here. */
	.shifted {
		transform: translateY(calc(var(--row-shift, 0) * var(--row-h, 0px)));
	}
	@media (prefers-reduced-motion: no-preference) {
		.shifted {
			transition: transform 160ms cubic-bezier(0.32, 0.72, 0, 1);
		}
	}
</style>
