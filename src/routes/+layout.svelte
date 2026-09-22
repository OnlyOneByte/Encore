<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import {
		SINGER_COLORS,
		songDisplay,
		isPlayable,
		hasGuidingTrack,
		effectiveGuideLevel,
		chosenCandidate,
		type LyricsCandidate,
		type SongProfile
	} from '$lib/contract';
	import NowPlayingDrawer from '$lib/components/NowPlayingDrawer.svelte';
	import { room } from '$lib/stores/room';

	let { children } = $props();

	/*
	 * WHICH SURFACES ARE PHONES. The band is app chrome for the remote, and this is the ROOT layout, so
	 * it wraps the television too — an ungated `room.connect()` here would open a `role=phone` socket on
	 * /tv, which already holds its own `role=tv` one, and register the television as a singer present in
	 * the room.
	 *
	 * The list is deliberately the SAME four exemptions `phone-inventory.test.ts` already enforces for
	 * the phone route walk, rather than a second opinion about what a phone surface is. Two lists that
	 * can disagree about that is a defect waiting for whichever one nobody updates.
	 */
	const NOT_PHONE = ['/tv', '/components', '/admin', '/metrics'];
	const isPhoneSurface = $derived(
		!NOT_PHONE.some((r) => page.url.pathname === r || page.url.pathname.startsWith(r + '/'))
	);

	/*
	 * THE MAGNIFIER IS GONE FROM THE BAND (2026-09-22), and with it `openSearch` and the `searchFocus` store
	 * it requested through.
	 *
	 * Its whole history in three steps: it pushed `?browse=1` to reveal a docked box; it navigated to the
	 * `/find` route; and for about an hour it focused the field on home through a store, because app chrome
	 * cannot see a route's locals. None of that is needed once search is a field at the TOP of the home
	 * column — the first thing on the screen a joined singer lands on. A magnifier in the chrome to reach a
	 * field that is already the first thing in the document is a control that answers a question nobody has.
	 *
	 * WHAT THE BAND SPENDS THE ROW ON INSTEAD: the transport, in full, at all times. Restart and skip used to
	 * be hidden at rest and grown in as the sheet rose, precisely because the magnifier shared the row.
	 */

	// Mirrored from the link — the same subscribe-and-mirror the route uses. Only the fields the band
	// renders, so a library merge or a queue reorder does not touch this component.
	let me = $state<string | null>(null);
	let title = $state<string | null>(null);
	let artist = $state<string | null>(null);
	let singerName = $state<string | null>(null);
	let singerColor = $state<string | null>(null);
	let isPlaying = $state(false);
	let positionSec = $state(0);
	let durationSec = $state(0);
	// Only the drawer reads these. They cost nothing while it is closed — the drawer's content is not
	// rendered at all until then — and mirroring them here keeps every room read in one place.
	let profile = $state<SongProfile | null>(null);
	let keyShift = $state(0);
	let keyShiftEnabled = $state(false);
	let guideServerPct = $state(0);
	let guideEnabled = $state(false);
	let hasSong = $state(false);
	let canStart = $state(false);
	let mediaId = $state<string | null>(null);
	let candidates = $state<LyricsCandidate[]>([]);
	let chosenRef = $state<string | undefined>(undefined);
	let overrideRef = $state<string | undefined>(undefined);
	/*
	 * `newerExists` IS GONE FROM HERE (2026-09-21): it fed the sheet's re-selection disclosure — "a better
	 * match is available" — and that control moved to /song/[mediaId], which computes the same thing from the
	 * same pure helper at its own call site. The layout mirrors what the SHEET reads, and the sheet now only
	 * NAMES the lyrics source rather than offering to change it.
	 */

	onMount(() => {
		const sync = () => {
			me = room.me?.id ?? null;
			const entry = room.entries.find((e) => e.id === room.playback.currentEntryId);
			const media = entry ? room.mediaCatalog.get(entry.mediaId) : undefined;
			const display = songDisplay(media);
			title = entry ? display.title || media?.title || null : null;
			artist = entry ? (display.artist ?? media?.artist ?? null) : null;
			const singer = entry ? room.singers.get(entry.singerId) : undefined;
			singerName = entry ? (singer?.displayName ?? 'Someone') : null;
			singerColor = entry ? (singer?.color ?? SINGER_COLORS[0]) : null;
			isPlaying = room.playback.isPlaying;
			positionSec = room.playback.positionSec;
			durationSec = media?.durationSec ?? 0;
			hasSong = !!entry;
			canStart = room.entries.some((e) => e.status === 'queued');
			mediaId = media?.id ?? null;
			profile = media?.songProfile ?? null;
			keyShift = room.playback.keyShift;
			// ±key needs separated stems, and the guiding track needs an isolated vocals stem. Two
			// different gates, so a song can legitimately offer one and not the other.
			keyShiftEnabled = !!media && isPlayable(media);
			guideEnabled = !!media && hasGuidingTrack(media);
			guideServerPct = Math.round(
				effectiveGuideLevel({ guideLevel: room.playback.guideLevel }, room.roomGuideDefault) * 100
			);
			candidates = media?.lyricsCandidates ?? [];
			chosenRef = media ? chosenCandidate(media)?.ref : undefined;
			overrideRef = media?.lyricsOverrideRef;
		};
		sync();
		const stop = room.subscribe(sync);
		// The link is idempotent, so a second surface mounting is a no-op rather than a second socket.
		if (isPhoneSurface) void room.connect();
		return stop;
	});

	/*
	 * THE RING HAS TO ADVANCE BETWEEN BROADCASTS. `playback.positionSec` arrives on an event, not on a
	 * frame, so a ring driven straight off it would sit still for seconds and then jump. This carries
	 * the same anchor-and-extrapolate shape the route already uses for its elapsed readout: anchor on
	 * the last authoritative position, then add wall-clock while playing.
	 *
	 * ONE SECOND, not one frame. The ring is 44px across, so a whole second of a four-minute song moves
	 * its arc by well under a pixel — a rAF loop would burn a wake-up per frame to render nothing new.
	 *
	 * THE ANCHOR IS CAPTURED IN *THIS* EFFECT, and that is the whole correctness argument — do not lift
	 * it back out into its own `$state` + `$effect` pair.
	 *
	 * It used to live in a separate effect that tracked `positionSec` ALONE. `play` and `pause` both
	 * call `setPlayback({ isPlaying })` and never touch `positionSec` (server `player.ts`), and the
	 * position-only telemetry path deliberately does not broadcast `playback:state` at all — so a
	 * resume re-delivers the SAME number. Writing an equal primitive into a `$state` scalar notifies
	 * nothing (strict `===`), so the anchor effect did not re-run while this one did, and the interval
	 * then extrapolated from the wall clock recorded at PAUSE time. One second after every resume the
	 * ring and the drawer's clock jumped forward by the full pause duration and stayed there; a long
	 * enough pause clamped the ring full and drove the remaining time to zero on a song still playing.
	 *
	 * The route's own copy (`+page.svelte`) has the two-effect shape and is fine, because it reads
	 * `playback.positionSec` off a whole-object `$state` that `room.ts` REPLACES on every broadcast — so
	 * its anchor effect re-runs on any playback change. Mirroring the fields as scalars here (which is
	 * what keeps the band cheap) is exactly what narrowed that dependency set, so this file cannot
	 * borrow that shape. Capturing `pos`/`wall` as locals in the effect that already tracks BOTH
	 * signals makes a stale anchor unrepresentable: every re-run re-reads the clock.
	 */
	let livePos = $state(0);
	$effect(() => {
		const pos = positionSec;
		const wall = performance.now();
		livePos = pos;
		if (!isPlaying) return;
		const id = setInterval(() => (livePos = pos + (performance.now() - wall) / 1000), 1000);
		return () => clearInterval(id);
	});

	/*
	 * `null` IS NOT ZERO, and the band draws them differently on purpose. A song whose duration is
	 * unknown (never probed, or a live stream) gets an EMPTY ring, which reads as "no idea how far in";
	 * a zeroed ring would claim the song had just started and then never move.
	 */

	// Only a joined singer gets the band: a guest on the landing page has no room to be a remote for.
	const showBand = $derived(isPhoneSurface && me !== null);

	/**
	 * THE BAND CONTRACT, and it lives here now because the band is the bottom-most thing on the screen.
	 *
	 * Its REAL rendered height is published to documentElement so every scrolling column can reserve it
	 * in normal flow instead of having the band float over the last row. MEASURED, not a
	 * constant, and that is the whole point: a hardcoded guess leaves the last row bleeding under the
	 * band the moment the copy, the font or the safe-area inset changes.
	 *
	 * THE INSET LIVES ON THE BAND ALONE — `NowPlayingBand`'s own `padding-bottom` carries
	 * env(safe-area-inset-bottom), and that inset reaches everything stacked above it THROUGH --dock-h.
	 * So nothing above may add a second env() term or the gap doubles. One env(), on the one element
	 * that actually sits at the bottom edge of the screen. It used to be `.search-dock` in the route,
	 * which stopped being true the moment something docked BELOW it.
	 *
	 * THE TEARDOWN IS PART OF THE CONTRACT, not tidiness. A custom property written to documentElement
	 * OUTLIVES the component that wrote it, and because an inline property on :root outranks a
	 * stylesheet rule it silently defeats any media query that tries to set the same token. This
	 * component is the app shell so it effectively never unmounts — which makes the cleanup look
	 * pointless and is exactly why it must be written down: the ONE case that does unmount it is a
	 * surface with no band (the television), and there a stale --dock-h would pad the TV's stage by a
	 * phone's band height.
	 */
	/* Seeded with a plausible band height, not 0: this is bound to the drawer's `bandH`, which IS
	   snap point 0, and a parent 0 pushed down on mount would collapse the sheet to `0px` for the
	   frame before the real measurement arrives. */
	let dockH = $state(72);
	$effect(() => {
		document.documentElement.style.setProperty('--dock-h', `${dockH}px`);
		return () => {
			document.documentElement.style.removeProperty('--dock-h');
		};
	});
</script>

<svelte:head>
	<!-- Encore's app mark, from static/. The PNG sizes the manifest points at are its siblings, so
	     the icon family has one home; the favicon used to be a Vite-processed import from
	     src/lib/assets/ instead, which is how it drifted to the stock SvelteKit Svelte logo without
	     anyone noticing. -->
	<link rel="icon" href="/icon.svg" type="image/svg+xml" />
</svelte:head>

<div class="app-shell">
	{@render children()}
</div>

<!--
	ONE MOUNT, TWO HEIGHTS. The band used to be a separate fixed element in a `.dock` wrapper here,
	with this drawer as its sibling expansion and an `onexpand` callback between them. Both the wrapper
	and the callback are gone: the band is snap point 0 of the drawer (see NowPlayingDrawer.svelte), so
	there is one element to position and vaul does the positioning.

	That retires three things this file used to own. `.dock` — vaul fixes the content itself. The
	`class:covered={drawerOpen}` opacity fade, which existed only because the band and the drawer were
	two surfaces with matching top edges and one had to step out from under the other; with a single
	surface there is nothing to hide. And `drawerOpen`, because a permanently-mounted sheet has no
	open/closed state — it has a snap point, which the drawer owns.

	`showBand` KEEPS ITS NAME and its meaning: it is what decides whether a joined singer on a phone
	surface gets the remote's chrome at all. `--dock-h` also stays exactly what it was, the band's real
	rendered height, now measured inside the drawer at snap 0 and handed back through `bind:bandH` so
	this file remains its single writer.
-->
{#if showBand}
	<NowPlayingDrawer
		bind:bandH={dockH}
		title={title}
		artist={artist}
		singerName={singerName}
		singerColor={singerColor}
		profile={profile}
		keyShift={keyShift}
		keyShiftEnabled={keyShiftEnabled}
		guideServerPct={guideServerPct}
		guideEnabled={guideEnabled}
		elapsedSec={livePos}
		durationSec={durationSec}
		isPlaying={isPlaying}
		hasSong={hasSong}
		canStart={canStart}
		mediaId={mediaId}
		candidates={candidates}
		chosenRef={chosenRef}
		overrideRef={overrideRef}
		onrestart={() => room.command({ cmd: 'restart' })}
		ontoggleplay={() => room.command({ cmd: isPlaying ? 'pause' : 'play' })}
		onskip={() => room.command({ cmd: 'skip' })}
		onkey={(semitones) => room.command({ cmd: 'key', semitones })}
		onguide={(level) => room.command({ cmd: 'guide', level })}
	/>
{/if}

<style>
	/*
	 * The drawer covers the band once open, so this changes nothing at rest — it changes the 500ms in
	 * between, which is where the trouble was. Band and drawer are the same surface colour with the same
	 * top border, so a sheet rising over the band showed two matching top edges at once and read as a
	 * second copy of the same panel arriving rather than the panel growing.
	 *
	 * Opacity only, and the band stays in the layout, so `--dock-h` never moves and no column reflows
	 * while the drawer is open. `visibility` is deliberately not used: it would cut the fade to a pop.
	 */
</style>
