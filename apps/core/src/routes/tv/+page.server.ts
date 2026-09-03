// TV attract screen load: build the join QR (data URL) from the request origin so phones on the
// LAN can scan it. Generated server-side once per load.
import type { PageServerLoad } from './$types';
import QRCode from 'qrcode';
import { getApp } from '$server/app';

export const load: PageServerLoad = async ({ url }) => {
	const joinUrl = `${url.origin}/join`;
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
	try {
		interstitialMs = getApp().settings.getRoom().interstitialMs;
	} catch {
		// The app singleton is absent when this route is prerendered or unit-loaded; the env default is
		// the correct answer there rather than a failed load.
	}
	return { joinUrl, qrDataUrl, interstitialMs };
};
