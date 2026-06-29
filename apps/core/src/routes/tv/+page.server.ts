// TV attract screen load: build the join QR (data URL) from the request origin so phones on the
// LAN can scan it. Generated server-side once per load.
import type { PageServerLoad } from './$types';
import QRCode from 'qrcode';

export const load: PageServerLoad = async ({ url }) => {
	const joinUrl = `${url.origin}/join`;
	const qrDataUrl = await QRCode.toDataURL(joinUrl, {
		margin: 1,
		width: 320,
		color: { dark: '#0b0b12', light: '#ffffff' }
	});
	return { joinUrl, qrDataUrl };
};
