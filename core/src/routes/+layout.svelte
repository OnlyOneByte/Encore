<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { SINGER_COLORS, songDisplay, type PlayerCommand } from '$lib/contract';
	import { nextPlayableEntryId } from '$lib/readiness';
	import { room } from '$lib/stores/room';
	import { drawPosition, secondTicker } from '$lib/playhead';
	/* STATIC IMPORTS, where the drawer needed a dynamic one. The whole reason that `import()` existed was
	   `vaul-svelte` + `bits-ui`, which /tv, /admin and /metrics downloaded and parsed while rendering no band at all
	   — which is why the root layout went to such lengths to defer and then warm it. The strip and the tab bar carry
	   no third-party dependency between them, so there is no chunk left to defer and the await block, its warm-up
	   effect and the first-load fetch a guest at a party used to pay are all gone with it. MEASURED after the
	   deletion, and every figure here off this tree's own `bun run build`: `vaul` appears in NO client artifact —
	   not a chunk, not a stylesheet. Its last importer was the /components gallery (nodes/10), now 38.00 kB raw /
	   11.46 kB gzip with a 1,475 B stylesheet. And the ROOT stylesheet, which every surface downloads including
	   /tv, LOST 5,152 B when `components/ui/drawer/` was deleted (55,927 -> 50,775). 3,211 of those bytes were
	   24 rules whose selector spelled `data-[vaul-drawer-direction=…]`, which Tailwind emitted because it scans
	   that directory whether or not anything rendered it.
	   READ THE DELTA, NOT THE ABSOLUTE — and this comment is its own cautionary tale. It first said 50,739, a
	   reading taken mid-change and then invalidated 36 bytes later by `grid-template-columns: minmax(0, 1fr)` in
	   this file's OWN `.dock` rule, which compiles into this very stylesheet as exactly 36 bytes. So the absolute
	   moves with any rule anyone adds anywhere, including one added below this paragraph after it was written. If
	   you touch a style here, re-measure or say less. */
	import NowPlayingStrip from '$lib/ui/NowPlayingStrip.svelte';
	import TabBar from '$lib/ui/TabBar.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { Toaster } from '$lib/components/ui/sonner';

	let { children } = $props();

	/* The one list of non-phone surfaces, matched on the route or any descendant. This is the root layout, so an
	   ungated `room.connect()` would open a second `role=phone` socket on /tv and register the television as a singer.
	   See docs/FRONTEND.md#phones-versus-the-television. */
	const NOT_PHONE = ['/tv', '/components', '/admin', '/metrics'];
	const isPhoneSurface = $derived(
		!NOT_PHONE.some((r) => page.url.pathname === r || page.url.pathname.startsWith(r + '/'))
	);

	/* Mirrored from the link as scalars: only the fields the STRIP renders, so a library merge or a queue reorder
	   does not touch this component. Nine fields the drawer needed — profile, keyShift, keyShiftEnabled,
	   guideServerPct, guideEnabled, mediaId, candidates, chosenRef, overrideRef — are gone from here, not dropped:
	   they belong to the live-controls card at the top of /queue, which mirrors them itself. A field read in the
	   root layout is read on every surface in the app, so the narrower this list is the less work /tv does. */
	let me = $state<string | null>(null);
	let title = $state<string | null>(null);
	let singerName = $state<string | null>(null);
	let singerColor = $state<string | null>(null);
	let isPlaying = $state(false);
	let positionSec = $state(0);
	let durationSec = $state(0);
	let hasSong = $state(false);
	let canStart = $state(false);
	// For the dock's offline cue — see the banner in the markup for why it lives here and not on a route.
	let connected = $state(true);
	// Presence is keyed on the rotation having ANYTHING in it; `canStart` keys only the play button. See the strip.
	let queueCount = $state(0);

	onMount(() => {
		const sync = () => {
			me = room.me?.id ?? null;
			const entry = room.entries.find((e) => e.id === room.playback.currentEntryId);
			const media = entry ? room.mediaCatalog.get(entry.mediaId) : undefined;
			const display = songDisplay(media);
			title = entry ? display.title || media?.title || null : null;
			const singer = entry ? room.singers.get(entry.singerId) : undefined;
			singerName = entry ? (singer?.displayName ?? 'Someone') : null;
			singerColor = entry ? (singer?.color ?? SINGER_COLORS[0]) : null;
			isPlaying = room.playback.isPlaying;
			positionSec = room.playback.positionSec;
			durationSec = media?.durationSec ?? 0;
			hasSong = !!entry;
			/* PLAYABLE, not merely queued. `some(status === 'queued')` was wrong and it reproduced the exact defect the
			   strip was built to remove. The app's one compound action queues a turn AND starts stem separation, so
			   immediately afterwards there is a queued entry with no stems: the server's `play` handler finds no
			   `nextPlayable`, sets `isPlaying: false` and emits no error, so no toast appears — while the strip showed
			   "Ready when you are" beside the only --accent fill on the screen, and tapping it did nothing. /queue
			   told the truth about the same entry ("Making karaoke…" with a progress bar) and the dock contradicted it.
			   `nextPlayableEntryId` is the SAME predicate the server's `nextPlayable` uses, so the strip can no longer
			   promise a turn the server will skip. */
			queueCount = room.entries.filter((e) => e.status === 'queued').length;
			connected = room.connected;
			canStart =
				nextPlayableEntryId(
					room.entries.filter((e) => e.status === 'queued'),
					(id) => room.mediaCatalog.get(id),
					(id) => room.mediaStatus.get(id)
				) !== null;
		};
		sync();
		return room.subscribe(sync);
	});

	/* AN EFFECT, NOT `onMount`, and that is a bug fix rather than a preference. This is the ROOT layout, so it is not
	   remounted across a client-side navigation — `onMount` therefore ran exactly once, on the surface first loaded.
	   Arriving at a phone surface from a non-phone one left `connect()` never called and the remote DEAD (no socket,
	   no queue, no band) until a hard reload. Both paths are real and shipped: `/admin`'s back link goes to `/`, and
	   `/metrics`'s goes to the machine scope of settings. Keyed on `isPhoneSurface`, which is derived from the pathname, so the arrival
	   itself is what triggers it. Still gated, for the original reason: an ungated connect would open a second
	   `role=phone` socket on /tv. `connect()` is idempotent, so re-running on any navigation within the phone
	   surfaces is a no-op rather than a second socket. */
	$effect(() => {
		if (!isPhoneSurface) return;
		void room.connect();
		/* NO WARM-UP IMPORT ANY MORE. There used to be a dynamic `import()` of the now-playing sheet here — the
		   component is deleted, so there is no path left to spell — so that a guest who hard-loaded a phone surface
		   and then joined did not wait on the vaul chunk before any transport appeared. The service worker could not
		   cover that, because it installs after the first load, which is the only load a guest at a party has. The
		   strip is statically imported, so the transport is in the shell that already painted and there is nothing
		   left to pre-fetch. */
	});

	/* `positionSec` arrives on a broadcast, not a frame, so the ring extrapolates between them. BOTH READS STAY INSIDE
	   THIS EFFECT: a resume re-delivers an equal `positionSec`, and writing an equal primitive notifies nothing, so a
	   separate anchor effect would never re-run. One second, not a frame — the arc moves sub-pixel. The arithmetic is
	   `$lib/playhead`'s, shared with the phone home and the TV reel, and it floors the elapsed term where this site
	   used to omit that. See docs/FRONTEND.md#the-dock-and---dock-h. */
	let livePos = $state(0);
	$effect(() => {
		const positionSecAnchor = positionSec;
		const anchoredAtMs = performance.now();
		const playing = isPlaying;
		livePos = positionSecAnchor;
		return secondTicker(playing, () => {
			livePos = drawPosition({ positionSec: positionSecAnchor, playing, anchoredAtMs, nowMs: performance.now() });
		});
	});

	/* THE TRANSPORT'S DROPPED-COMMAND NOTICE, and the argument for it, because a toast per tap needs one.
	   `room.command` reports whether the frame reached the wire; false means the socket was absent or not OPEN, so
	   the server never heard it. A player command is NOT resent on resync the way a queue add is, so dropped means
	   lost — and these three buttons were the sites that discarded that boolean.
	   WHAT THEY DO NOT NEED is the guard the ± keycaps and the guiding-track slider got. Those hold an optimistic
	   value, so a drop there left them SHOWING a state the room does not have; these hold none — the play/pause
	   icon follows `playback.isPlaying`, which only moves on a broadcast — so there is nothing to roll back.
	   WHAT THEY DO NEED IS A SAY, and for a sharper reason than the other two: on SUCCESS, restart and skip change
	   nothing in this strip either. The next broadcast redraws it. So "nothing happened" is indistinguishable from
	   "it worked", which is the one shape where silence cannot be read at all, and the guest's only remaining move
	   is to tap again.
	   WHY NOT JUST THE `.offline-bar` BELOW. It answers "is the link up?", where a tap asks "did MY skip happen?",
	   and it deliberately refuses to say which taps survive — its own note records the split, because the queue's
	   do and the transport's do not. Nor is it reliably up when a send fails: `connected` flips in the socket's
	   `onclose`/`#presumeDead`, while a send reports false as soon as `readyState` leaves OPEN, so a tap in the
	   window before `close` is dispatched is lost under a bar that is not showing yet. THE CONVERSE LIMIT IS REAL
	   AND NEITHER CUE COVERS IT: a frozen socket is still OPEN, so the send returns true and the command is lost
	   silently. `WsClient`'s liveness watchdog and its `offline` listener are what shorten that window; no boolean
	   at this call site can see it.
	   ONE NOTICE, NOT ONE PER TAP: sonner keys toasts by `id`, so a mash updates the single notice and resets its
	   timer rather than stacking a tower of them over the dock. */
	/* THE ONE SINK FOR THE LINK'S ERROR CHANNEL. The link drops a message nobody listens for, so a sink per route left
	   every route without one (all of /settings) silent. The layout outlives every navigation, as the link does. */
	onMount(() => room.onError((message) => toast.error(message, { duration: 4000 })));

	function transport(command: PlayerCommand): void {
		if (room.command(command)) return;
		toast.error("Not connected — the TV didn't hear that.", { id: 'transport-dropped', duration: 4000 });
	}

	// A guest on the landing page has no room to be a remote for.
	const showChrome = $derived(isPhoneSurface && me !== null);

	/* THE SINGLE WRITER OF --dock-h, the bottom chrome's MEASURED height, which every scrolling column reserves in
	   normal flow. Measured rather than derived from tokens, and app.css records the attempt that failed: a tab
	   renders 45px against a declared 44 because its icon-and-label content outgrows the 32px inside
	   `min-height: var(--tap)`, and that content-driven height is correct — a frozen height would clip the label at
	   the browser's 200% text-only zoom.
	   Seed is a plausible height, not 0, so a column reserves roughly the right space on the frame before the bind
	   lands rather than jumping. The teardown is contractual, not tidy: an inline property on :root outranks
	   stylesheets, and a left-behind value would pad the television's stage by a dock it has not got. Returning
	   early is sufficient BECAUSE of that teardown — when `showChrome` flips the effect re-runs, the previous run's
	   cleanup removes the property, and `var(--dock-h, 0px)` falls back to 0.
	   THE MOUNT-RUNG RULE applies to the binding below: `bind:clientHeight` is a geometry read, which the unit-test
	   harness hardens to a throw rather than letting a fabricated zero pass. No unit test mounts this layout today.
	   One that does will need a layout engine, and that is the constraint to honour rather than work around — the
	   strip's own presence is reactive, so the binding re-runs, which is exactly the shape the harness objects to. */
	let dockH = $state(91);
	$effect(() => {
		if (!showChrome) return;
		document.documentElement.style.setProperty('--dock-h', `${dockH}px`);
		return () => {
			document.documentElement.style.removeProperty('--dock-h');
		};
	});
</script>

<svelte:head>
	<!-- THE FALLBACK TITLE, and it belongs here because five routes had NONE — `/`, `/library`, `/song/[mediaId]`,
		`/tv` and the join screen all shipped untitled, which is the three surfaces a guest actually uses. The title is
		the first thing announced on a navigation and the only thing distinguishing history entries (SC 2.4.2). A route's
		own `<svelte:head><title>` still wins, because the last one in the head order does; this only fills the gap. -->
	<title>Encore</title>
	<!-- Served from static/, alongside the PNG sizes the manifest names, so the icon family has one home. -->
	<link rel="icon" href="/icon.svg" type="image/svg+xml" />
</svelte:head>

<!-- ONE TOASTER FOR THE WHOLE APP, and the three route-local mounts it replaces were a real defect rather than
	duplication. `toast()` pushes into a MODULE-LEVEL sonner store; a toast pushed while no <Toaster> is mounted is
	HELD and replayed on the next mount. So tapping "make karaoke", switching to the Queue tab, and having the
	server refuse meant the refusal was invisible on /queue for as long as you stayed there — then appeared on the
	Sing tab seconds or minutes later, on a screen whose query had been wiped, naming no song.
	THE OFFSET IS SET TWICE, AND ONE OF THEM WAS THE WHOLE POINT. A toast clears the bottom chrome by riding
	--dock-h, which resolves to 0 on surfaces with no dock — but sonner reads `--offset-bottom` only ABOVE its own
	600px breakpoint and `--mobile-offset-bottom` at or below it, and the `offset` prop feeds the first alone. So
	on every phone width — which is every width that HAS a dock — the standing value was its `mobileOffset`
	default of 16px, and the toast landed on the dock. MEASURED at 390x844 with a song playing and the offline bar
	up: --dock-h 116px, the dock's top edge at 728, and the toast's box at 774.5-828 — 828 being 844 - 16 exactly
	— so it covered all three transport buttons (each 754-798). That is the worst case there is for the one toast
	that is ABOUT those buttons: a notice saying skip did not land, sitting on top of skip.
	Each rung keeps sonner's OWN gap above the chrome rather than one shared number, because those two constants
	(VIEWPORT_OFFSET 24px, MOBILE_VIEWPORT_OFFSET 16px) are the rungs the library's own spacing is drawn at.
	AN OBJECT, NOT A BARE STRING, and this is measured too: a scalar offset is `assignAll`ed to top, right, bottom
	AND left, so a bottom inset of `--dock-h + 16px` also became a 132px inset on each side — the toast narrowed
	to 126px of the 390 viewport and the one sentence wrapped onto four lines. Naming only `bottom` leaves the
	other three at the library's defaults, which is what the full-width toast was relying on by accident before. -->
<Toaster
	position="bottom-center"
	offset={{ bottom: 'calc(var(--dock-h, 0px) + 24px)' }}
	mobileOffset={{ bottom: 'calc(var(--dock-h, 0px) + 16px)' }}
	style="--width: min(92vw, 420px);"
/>

<div class="app-shell">
	{@render children()}
</div>

{#if showChrome}
	<!-- ONE FIXED CONTAINER HOLDING BOTH, not two separately-fixed elements. The tab bar composes the home-indicator
		inset and the strip composes none, which only works if the strip is stacked ON the tab bar in normal flow
		inside a single positioned parent — two fixed siblings would each need their own inset arithmetic and would
		disagree the moment one of them changed height. -->
	<div class="dock" bind:clientHeight={dockH}>
		<!-- THE OFFLINE CUE, AND IT BELONGS HERE RATHER THAN ON A ROUTE. It used to exist only in `/`'s topbar, which
			is deliberately NOT sticky, so on a 59-row result list it was measured at `top: -2420px, inViewport: false`
			— present in the DOM, 2.4k pixels above the fold, on the one surface that needs it least. `/queue` owns
			pause, skip, ±semitone and the guiding-track slider and read `room.connected` nowhere at all; `/library`
			likewise. Three of the behavioural review's findings were that same gap on three surfaces.
			The dock is `position: fixed` and renders on every joined phone surface, so a cue here is visible at every
			scroll position on every route, and there is exactly one of it.
			--warn, NOT --danger: a dropped socket self-heals on the next backoff tick, and --danger is reserved for a
			failure that will not. The queue store keeps accepting taps while offline and resends them on resync, so
			this is "your taps are being held" for a QUEUE op and "your taps are lost" for a PLAYER command, which is
			why the copy says only Reconnecting.
			IT USED TO SAY "your taps are saved", AND THAT WAS HALF FALSE. `QueueStore.resendPending()` really does
			replay a pending add or move on resync, so for the queue it was true. Player commands — pause, skip,
			±key, the guiding track — go through `RoomLink.command`, which is one `#ws?.send()` with no pending
			ledger behind it: dropped means lost. Promising both was the same overstatement this review kept
			finding elsewhere, so the bar now states the fact it can keep and nothing more.
			THE OTHER HALF OF THAT SPLIT IS `transport()` ABOVE, which says the thing this bar cannot: not "the
			link is down" but "the command you just issued was lost". Those are different questions, and this bar
			can only ever answer the first. -->
		{#if !connected}
			<p class="offline-bar" role="status" aria-live="polite">
				<Icon name="warning" /> Reconnecting…
			</p>
		{/if}
		<NowPlayingStrip
			title={title}
			singerName={singerName}
			singerColor={singerColor}
			isPlaying={isPlaying}
			elapsedSec={livePos}
			durationSec={durationSec}
			hasSong={hasSong}
			canStart={canStart}
			queueCount={queueCount}
			onrestart={() => transport({ cmd: 'restart' })}
			ontoggleplay={() => transport({ cmd: isPlaying ? 'pause' : 'play' })}
			onskip={() => transport({ cmd: 'skip' })}
		/>
		<TabBar pathname={page.url.pathname} />
	</div>
{/if}

<style>
	/* FIXED, and the app's only bottom chrome. `.app-shell` is centred and width-capped, so the dock is NOT inside
	   it: on a tablet the shell is 760px wide and a dock inside it would float in the middle of the screen with page
	   either side. The inner rows carry their own max-width instead, which is why this is a grid rather than a block.
	   --z-dock is the token the TV's tiers deliberately sit below. */
	.dock {
		position: fixed;
		inset-inline: 0;
		inset-block-end: 0;
		z-index: var(--z-dock);
		display: grid;
		/* `minmax(0, 1fr)`, NOT the implicit `auto` track, and it is load-bearing — this is FRONTEND.md's min-width:0
		   rule applied one level up from the strip, where the strip's own `.meta` applies it. MEASURED, at 320x800
		   with a song playing: the implicit track sized itself to the strip's MIN-CONTENT, 356.11px, inside a `.dock`
		   that is correctly 320px wide. Both rows take `width: 100%` of the TRACK, so the strip, its progress rail,
		   the whole transport group and the Library tab all sat 36.1px past the right edge — skip's box ended at
		   344.1 and the tab bar at 356.1 — while `document.scrollWidth` stayed 320, so nothing scrolled to reveal
		   them. The min-content came from the strip's `.song`, which contributed 89.94px to the track even though it
		   carries `min-width: 0` (that removes the automatic minimum; it does not cap the min-content CONTRIBUTION).
		   Capping the track at the container makes the flex row shrink instead, which is what `.song`'s ellipsis is
		   for. No effect at 390 and up, where the track was already narrower than the viewport. */
		grid-template-columns: minmax(0, 1fr);
		/* The chrome spans the viewport but its CONTENT aligns with the column above it, or the transport sits under
		   the page's trailing margin on a wide screen while the rows it controls sit inboard. */
		justify-items: center;
	}

	.offline-bar {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-xs);
		margin: 0;
		padding: var(--space-2xs) var(--space-lg);
		background: var(--warn-bg);
		border-top: 1px solid var(--warn-line);
		color: var(--warn);
		font-size: var(--ph-text-sm);
		/* NO nowrap and a floor of none: this bar spans the dock's full width, so a long string wraps to a second
		   line rather than overflowing. The pill it replaced was `white-space: nowrap` in a flex topbar, where its
		   133px min-content width pushed `scrollWidth` to 334 against a 320 viewport. */
		text-align: center;
	}

	.dock > :global(*) {
		width: 100%;
		max-width: var(--max-w);
	}

	/* The blur is the surface the strip and the tab bar both sit on, declared once here rather than twice in them:
	   two translucent layers stacked compound into a darker band than either declares. */
	@supports (backdrop-filter: blur(1px)) {
		.dock {
			backdrop-filter: var(--chrome-blur);
		}
	}
</style>
