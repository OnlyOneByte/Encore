// TV attract screen load: build the join QR (data URL) from the address phones should use, so they can
// scan it. Generated server-side once per load.
//
// NOT from `url.origin`, and not from this request alone: adapter-node reports https for every request
// unless PROTOCOL_HEADER is set (so `url.origin` produced an unopenable https QR on a plain-HTTP LAN),
// and the TV's own address is frequently one only the TV can reach — a WSL2 host opens /tv at
// `localhost`, which would hand every phone a QR pointing at itself. `joinOrigin()` prefers the
// declared address (settings, then env) and falls back to the request. See $server/public-origin.
import type { PageServerLoad } from './$types';
import QRCode from 'qrcode';
import { getApp } from '$server/app';
import { joinOrigin, fallbackJoinOrigin } from '$server/public-origin';
import { DEFAULT_EFFECTIVE_SETTINGS, type EffectiveSettings } from '@encore/shared';

export const load: PageServerLoad = async ({ url, request }) => {
	const origin = joinOrigin(request, url);
	// What an empty setting resolves to (env, else this request). The TV needs it to recognise a
	// settings change that CLEARED the address, which moves the QR back to this value.
	const fallback = fallbackJoinOrigin(request, url);
	// Advertise THIS room's join code in the QR (#654), so a scan lands the phone in this party rather
	// than at a bare landing. The code is a query param the landing page (`/`) reads and forwards to
	// /api/join. Absent only if the app singleton is unavailable (prerender/unit load), where a plain
	// `/` is the honest fallback.
	// #658 one-TV-per-room: resolve WHICH room this TV shows. An explicit ?room=<code> (validated
	// against the room repo) points the TV at that specific party; a bare /tv falls back to the room
	// this box serves (activeRoomId), which is the pre-#658 behaviour. The resolved code is both what
	// the QR advertises AND what the client passes on its WS URL (?room=<code>) so the socket binds to
	// the same room — see tvRoomId in the WS upgrade. An unknown ?room code falls through to the
	// served room rather than a code-less TV, so a stale code never dark-screens the display.
	let roomCode = '';
	try {
		const app = getApp();
		const requested = url.searchParams.get('room')?.trim();
		const named = requested ? app.rooms.byCode(requested) : null;
		roomCode = (named ?? app.rooms.byId(app.activeRoomId))?.code ?? '';
	} catch {
		// No app singleton under prerender/unit load — fall back to a code-less join URL.
	}
	const joinUrl = roomCode ? `${origin}/?room=${encodeURIComponent(roomCode)}` : `${origin}/`;
	const qrDataUrl = await QRCode.toDataURL(joinUrl, {
		margin: 1,
		width: 320,
		color: { dark: '#0b0b12', light: '#ffffff' }
	});
	// Room pacing and presentation, plus the global layer the presentation is clamped against.
	//
	// Returned as ONE `EffectiveSettings` rather than field-by-field: the TV needs both layers to call
	// `resolveLyricsPresentation`, and copying individual fields out here and again in the
	// `settings:changed` branch is two lists that drift the moment a field is added.
	//
	// ENCORE_SONG_INTRO_MS remains the deployment default a room starts from (INTERSTITIAL_MS is still
	// read as a deprecated alias), so an existing install behaves as before until someone moves the
	// slider. `=0` means the intro is OFF, which is now the toggle rather than a sentinel duration. The
	// TV also applies settings:changed live, so a change mid-party does not need a reload.
	const envRaw = process.env.ENCORE_SONG_INTRO_MS ?? process.env.INTERSTITIAL_MS;
	const envMs = envRaw === undefined ? undefined : Math.max(0, Number(envRaw));
	const envRoom =
		envMs === undefined || !Number.isFinite(envMs)
			? {}
			: envMs === 0
				? { songIntroEnabled: false }
				: { songIntroEnabled: true, songIntroMs: envMs };
	let settings: EffectiveSettings = {
		...DEFAULT_EFFECTIVE_SETTINGS,
		room: { ...DEFAULT_EFFECTIVE_SETTINGS.room, ...envRoom }
	};
	try {
		const app = getApp();
		settings = app.settings.getEffective(app.activeRoomId);
	} catch {
		// The app singleton is absent when this route is prerendered or unit-loaded; the env default is
		// the correct answer there rather than a failed load.
	}
	// `joinOrigin` rides along so the TV can tell a settings change that moved the join address from one
	// that did not: the QR is a server-rendered image, so only that case needs the load to re-run.
	// The song-intro hold and `tvProgressStyle` are not returned separately — they are in `settings`.
	return { joinUrl, qrDataUrl, joinOrigin: origin, joinFallbackOrigin: fallback, settings, roomCode };
};
