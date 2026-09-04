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
import type { TvProgressStyle } from '@encore/shared';

export const load: PageServerLoad = async ({ url, request }) => {
	const origin = joinOrigin(request, url);
	// What an empty setting resolves to (env, else this request). The TV needs it to recognise a
	// settings change that CLEARED the address, which moves the QR back to this value.
	const fallback = fallbackJoinOrigin(request, url);
	const joinUrl = `${origin}/join`;
	const qrDataUrl = await QRCode.toDataURL(joinUrl, {
		margin: 1,
		width: 320,
		color: { dark: '#0b0b12', light: '#ffffff' }
	});
	// Interstitial reveal duration (ms); 0 = pure gapless hard-cut. Room-scoped, because pacing is a
	// property of the party. INTERSTITIAL_MS remains the deployment default a room starts from, so an
	// existing install behaves as before until someone moves the slider. The TV also applies
	// settings:changed live, so a change mid-party does not need a reload.
	const envDefault = Math.max(0, Number(process.env.INTERSTITIAL_MS ?? 2500));
	let interstitialMs = envDefault;
	let tvProgressStyle: TvProgressStyle = 'card';
	try {
		const room = getApp().settings.getRoom();
		interstitialMs = room.interstitialMs;
		tvProgressStyle = room.tvProgressStyle;
	} catch {
		// The app singleton is absent when this route is prerendered or unit-loaded; the env default is
		// the correct answer there rather than a failed load.
	}
	// `joinOrigin` rides along so the TV can tell a settings change that moved the join address from one
	// that did not: the QR is a server-rendered image, so only that case needs the load to re-run.
	return { joinUrl, qrDataUrl, joinOrigin: origin, joinFallbackOrigin: fallback, interstitialMs, tvProgressStyle };
};
