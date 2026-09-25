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

	/* The one list of non-phone surfaces, matched on the route or any descendant. This is the root layout, so an
	   ungated `room.connect()` would open a second `role=phone` socket on /tv and register the television as a singer.
	   See docs/FRONTEND.md#phones-versus-the-television. */
	const NOT_PHONE = ['/tv', '/components', '/admin', '/metrics'];
	const isPhoneSurface = $derived(
		!NOT_PHONE.some((r) => page.url.pathname === r || page.url.pathname.startsWith(r + '/'))
	);

	// Mirrored from the link as scalars: only the fields the band renders, so a library merge or a queue reorder does
	// not touch this component.
	let me = $state<string | null>(null);
	let title = $state<string | null>(null);
	let artist = $state<string | null>(null);
	let singerName = $state<string | null>(null);
	let singerColor = $state<string | null>(null);
	let isPlaying = $state(false);
	let positionSec = $state(0);
	let durationSec = $state(0);
	// Drawer-only fields; mirrored here so every room read stays in one place.
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
			// Two different stem requirements, so a song can offer ±key without offering a guiding track.
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
		if (isPhoneSurface) void room.connect();
	});

	/* `positionSec` arrives on a broadcast, not a frame, so the ring extrapolates between them. Capture `pos` and
	   `wall` INSIDE the effect that reads `isPlaying` too: a resume re-delivers an equal `positionSec`, and an equal
	   primitive write notifies nothing, so a separate anchor effect would never re-run. One second, not a frame: the arc
	   moves sub-pixel. See docs/FRONTEND.md#the-band-and---dock-h. */
	let livePos = $state(0);
	$effect(() => {
		const pos = positionSec;
		const wall = performance.now();
		livePos = pos;
		if (!isPlaying) return;
		const id = setInterval(() => (livePos = pos + (performance.now() - wall) / 1000), 1000);
		return () => clearInterval(id);
	});

	// A guest on the landing page has no room to be a remote for.
	const showBand = $derived(isPhoneSurface && me !== null);

	/* This file is the SINGLE WRITER of --dock-h, the band's measured height, which every scrolling column reserves in
	   normal flow. Seed is a plausible height, not 0: it is bound to the drawer's snap point 0, which a pushed-down 0
	   would collapse for a frame. The teardown is contractual, not tidy — an inline :root property outranks stylesheets
	   and would pad the TV's stage by a band it has not got. See docs/FRONTEND.md#the-band-and---dock-h. */
	let dockH = $state(72);
	$effect(() => {
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

<!-- The band is the drawer's snap point 0; its height returns through `bind:bandH`, keeping one writer. -->
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
