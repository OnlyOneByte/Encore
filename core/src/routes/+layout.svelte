<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { SINGER_COLORS, songDisplay } from '$lib/contract';
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
	   `/metrics`'s goes to `/settings`. Keyed on `isPhoneSurface`, which is derived from the pathname, so the arrival
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

<div class="app-shell">
	{@render children()}
</div>

{#if showChrome}
	<!-- ONE FIXED CONTAINER HOLDING BOTH, not two separately-fixed elements. The tab bar composes the home-indicator
		inset and the strip composes none, which only works if the strip is stacked ON the tab bar in normal flow
		inside a single positioned parent — two fixed siblings would each need their own inset arithmetic and would
		disagree the moment one of them changed height. -->
	<div class="dock" bind:clientHeight={dockH}>
		<NowPlayingStrip
			title={title}
			singerName={singerName}
			singerColor={singerColor}
			isPlaying={isPlaying}
			elapsedSec={livePos}
			durationSec={durationSec}
			hasSong={hasSong}
			canStart={canStart}
			onrestart={() => room.command({ cmd: 'restart' })}
			ontoggleplay={() => room.command({ cmd: isPlaying ? 'pause' : 'play' })}
			onskip={() => room.command({ cmd: 'skip' })}
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
