<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		SINGER_COLORS,
		songDisplay,
		isPlayable,
		hasGuidingTrack,
		effectiveGuideLevel,
		chosenCandidate,
		hasNewerCandidateThanOverride,
		type LyricsCandidate,
		type SongProfile
	} from '$lib/contract';
	import NowPlayingBand from '$lib/components/NowPlayingBand.svelte';
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
	const isPhoneSurface = $derived(!NOT_PHONE.some((r) => page.url.pathname === r || page.url.pathname.startsWith(r + '/')));

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
	let newerExists = $state(false);

	onMount(() => {
		const sync = () => {
			me = room.me?.id ?? null;
			const entry = room.entries.find((e) => e.id === room.playback.currentEntryId);
			const media = entry ? room.mediaCatalog.get(entry.mediaId) : undefined;
			const display = songDisplay(media);
			title = entry ? (display.title || media?.title || null) : null;
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
			newerExists = media ? hasNewerCandidateThanOverride(media.lyricsCandidates, media.lyricsOverrideRef) : false;
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
	 */
	let anchor = $state({ pos: 0, wall: 0 });
	$effect(() => {
		anchor = { pos: positionSec, wall: performance.now() };
	});
	let livePos = $state(0);
	$effect(() => {
		livePos = positionSec;
		if (!isPlaying) return;
		const id = setInterval(() => (livePos = anchor.pos + (performance.now() - anchor.wall) / 1000), 1000);
		return () => clearInterval(id);
	});

	/*
	 * `null` IS NOT ZERO, and the band draws them differently on purpose. A song whose duration is
	 * unknown (never probed, or a live stream) gets an EMPTY ring, which reads as "no idea how far in";
	 * a zeroed ring would claim the song had just started and then never move.
	 */
	const progress = $derived(durationSec > 0 ? Math.max(0, Math.min(1, livePos / durationSec)) : null);

	// Only a joined singer gets the band: a guest on the landing page has no room to be a remote for.
	const showBand = $derived(isPhoneSurface && me !== null);
	/*
	 * The drawer's open state lives HERE, not in the band, because the band is presentational and the
	 * drawer is its sibling rather than its child. The band raises `onexpand`; this decides what that
	 * means. Closing is the drawer's own business (its handle, the overlay, Escape).
	 */
	let drawerOpen = $state(false);

	/**
	 * THE BAND CONTRACT, and it lives here now because the band is the bottom-most thing on the screen.
	 *
	 * Its REAL rendered height is published to documentElement so every scrolling column can reserve it
	 * in normal flow (XR-PH-12) instead of having the band float over the last row. MEASURED, not a
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
	let dockH = $state(0);
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
	THE DOCK IS A POSITIONING WRAPPER AND NOTHING ELSE — no paint, no padding, no inset. All three
	belong to NowPlayingBand, which already carries its own surface, its top border and the
	safe-area inset.

	The split exists because `position: fixed` cannot live on the component: /components renders FIVE
	bands stacked to show every state, and a fixed band would collapse all five onto the same strip at
	the bottom of the gallery. Docking is a property of this being the app's chrome, not of the band.
-->
{#if showBand}
	<div class="dock" bind:clientHeight={dockH}>
		<NowPlayingBand
			{title}
			{artist}
			{singerName}
			{singerColor}
			{progress}
			{isPlaying}
			onsearch={() => goto('/find')}
			ontoggleplay={() => room.command({ cmd: isPlaying ? 'pause' : 'play' })}
			onexpand={() => (drawerOpen = true)}
		/>
	</div>

	<!--
		The drawer is the band's expansion, so it is a SIBLING of the band rather than a child: vaul
		portals its content to the end of the body, and nesting it inside a `position: fixed` dock would
		put the portal's coordinate system inside the very element it has to cover.
	-->
	<NowPlayingDrawer
		bind:open={drawerOpen}
		{title}
		{artist}
		{singerName}
		{singerColor}
		{profile}
		{keyShift}
		{keyShiftEnabled}
		{guideServerPct}
		{guideEnabled}
		elapsedSec={livePos}
		{durationSec}
		{isPlaying}
		{hasSong}
		{canStart}
		{mediaId}
		{candidates}
		{chosenRef}
		{overrideRef}
		{newerExists}
		onrestart={() => room.command({ cmd: 'restart' })}
		ontoggleplay={() => room.command({ cmd: isPlaying ? 'pause' : 'play' })}
		onskip={() => room.command({ cmd: 'skip' })}
		onkey={(semitones) => room.command({ cmd: 'key', semitones })}
		onguide={(level) => room.command({ cmd: 'guide', level })}
		onpicklyrics={(ref) => mediaId && void room.reselectLyrics(mediaId, { ref })}
		onpastelyrics={(text) => mediaId && void room.reselectLyrics(mediaId, { text })}
	/>
{/if}

<style>
	.dock {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		/* The band paints itself and sets its own stacking context; this only says where. */
		z-index: var(--z-dock);
	}
</style>
