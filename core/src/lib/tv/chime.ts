// The host's test sound on Ready for tonight (proposal 39): one short chime on the room's TV, and its answer.
// Imported only when the host asks, so /tv loads none of it. A TV whose sound is locked says so at once and
// plays the chime on the next tap, which is the tap the room would otherwise make at the first song.
import type { WsClient } from '$lib/ws/client';

export type TvAudio = 'ok' | 'locked';

/** How long a resume may take before the TV reads as locked: a browser that wants a gesture never resolves it. */
const RESUME_MS = 400;

async function ring(): Promise<TvAudio> {
	const ctx = new AudioContext();
	await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, RESUME_MS))]);
	if (ctx.state !== 'running') {
		void ctx.close().catch(() => {});
		return 'locked';
	}
	const t = ctx.currentTime;
	// Two bell tones, rising: about a second in all.
	const tones: [number, number][] = [
		[880, 0],
		[1320, 0.18]
	];
	for (const [hz, at] of tones) {
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.frequency.value = hz;
		gain.gain.setValueAtTime(0.0001, t + at);
		gain.gain.exponentialRampToValueAtTime(0.3, t + at + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.8);
		osc.connect(gain).connect(ctx.destination);
		osc.start(t + at);
		osc.stop(t + at + 0.85);
	}
	setTimeout(() => void ctx.close().catch(() => {}), 1200);
	return 'ok';
}

/** The tap hint while the sound is locked, in the TV's own words (TvAudioNotice). Drawn here rather than by the page,
 *  so /tv carries no byte of it, and on the lobby too, where the page's own hint does not show. */
function hint(): HTMLElement {
	const el = document.createElement('div');
	el.setAttribute('role', 'status');
	el.textContent = 'Tap anywhere to start the music';
	el.style.cssText =
		'position:fixed;inset:0;z-index:60;display:grid;place-items:center;background:rgb(0 0 0 / 0.72);' +
		'color:#fff;font:700 clamp(32px,5vh,64px)/1.2 system-ui,sans-serif;text-align:center;padding:5vh';
	document.body.append(el);
	return el;
}

let waiting: HTMLElement | null = null;

/** Rings, and tells the server how it went (`tv:audio`). Locked: shows the tap hint, rings on the next tap or key,
 *  and reports that too. */
export async function chime(ws: WsClient | undefined): Promise<void> {
	const report = (audio: TvAudio) => ws?.send({ type: 'tv:audio', audio });
	const audio = await ring();
	report(audio);
	if (audio === 'ok' || waiting) return;
	waiting = hint();
	const onGesture = () => {
		waiting?.remove();
		waiting = null;
		removeEventListener('pointerdown', onGesture, true);
		removeEventListener('keydown', onGesture, true);
		void ring().then(report);
	};
	addEventListener('pointerdown', onGesture, true);
	addEventListener('keydown', onGesture, true);
}
