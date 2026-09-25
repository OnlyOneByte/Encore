// The join QR is built from the address PHONES should use, which is NOT `url.origin`: adapter-node reports https for
// every request unless PROTOCOL_HEADER is set, and the TV's own address is often one only the TV can reach (a WSL2 host
// opens /tv at `localhost`). `joinOrigin()` prefers the declared address — settings, then env — then the request.
import type { PageServerLoad } from './$types';
import QRCode from 'qrcode';
import { getApp } from '$lib/server/app';
import { joinOrigin, fallbackJoinOrigin } from '$lib/server/public-origin';
import { DEFAULT_EFFECTIVE_SETTINGS, type EffectiveSettings } from '$lib/contract';

export const load: PageServerLoad = async ({ url, request }) => {
	const origin = joinOrigin(request, url);
	// What an EMPTY setting resolves to, so the TV can recognise a change that CLEARED the address.
	const fallback = fallbackJoinOrigin(request, url);
	// ONE TV PER ROOM: the resolved code is both what the QR advertises AND what the client passes on its WS URL. An
	// UNKNOWN code falls through to the served room, so a stale code never dark-screens the display.
	// See docs/FRONTEND.md#the-tv-socket.
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
	// Returned as ONE `EffectiveSettings`, not field-by-field: the TV needs BOTH layers for
	// `resolveLyricsPresentation`, and a per-field copy here and again in `settings:changed` is two lists that drift.
	// `ENCORE_SONG_INTRO_MS=0` means the intro is OFF — the toggle, not a sentinel duration.
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
		// Absent under prerender/unit load; the env default is the correct answer, not a failed load.
	}
	// `joinOrigin` rides along so the TV can tell a settings change that MOVED the join address from one that did not:
	// the QR is a server-rendered image, so only that case needs the load to re-run.
	return { joinUrl, qrDataUrl, joinOrigin: origin, joinFallbackOrigin: fallback, settings, roomCode };
};
