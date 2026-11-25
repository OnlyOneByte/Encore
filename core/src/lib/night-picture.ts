// "Save picture" for Your night: the slide on screen drawn to a canvas, then shared or downloaded as a PNG.
// Share only where the browser allows it (a secure context; a LAN http:// page is not one), else a download.

export interface PictureSlide {
	kick: string;
	big?: string;
	rows?: [string, string][];
	sub: string[];
	/** The loudest song's title: the slide's hero fact, so it wraps to two lines rather than losing its end. */
	song?: string;
	/** Lines under `song`. */
	after?: string[];
}

const W = 1080;
const H = 1350;
const PAD = 96;
const GAP = 32;
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif';
/** Seven rows fit between the kick and the footer with the key line under them (440 + 7 × 96 + 80 < 1218). */
export const PICTURE_ROWS = 7;

/** `s`, or as much of it as fits in `max` with an ellipsis: never squashed, never over its neighbour. */
export function fitText(s: string, max: number, measure: (t: string) => number): string {
	if (measure(s) <= max) return s;
	let n = s.length;
	while (n > 0 && measure(`${s.slice(0, n).trimEnd()}…`) > max) n--;
	return `${s.slice(0, n).trimEnd()}…`;
}

/** `s` over at most `lines` lines of `max`, broken between words; only what still doesn't fit gets the ellipsis. */
export function wrapText(s: string, max: number, measure: (t: string) => number, lines = 2): string[] {
	const out: string[] = [];
	let rest = s.trim();
	while (rest && out.length < lines - 1) {
		if (measure(rest) <= max) break;
		const words = rest.split(' ');
		let n = words.length - 1;
		while (n > 1 && measure(words.slice(0, n).join(' ')) > max) n--;
		// One word left, or one word too long for a line: no break to make, so it is cut below.
		if (n < 1 || measure(words.slice(0, n).join(' ')) > max) break;
		out.push(words.slice(0, n).join(' '));
		rest = words.slice(n).join(' ');
	}
	if (rest) out.push(fitText(rest, max, measure));
	return out;
}

/** At most PICTURE_ROWS lines: a longer setlist keeps its first songs and says how many more. */
export function capRows(rows: readonly [string, string][]): [string, string][] {
	if (rows.length <= PICTURE_ROWS) return [...rows];
	return [...rows.slice(0, PICTURE_ROWS - 1), [`+${rows.length - PICTURE_ROWS + 1} more`, '']];
}

/** Lays the slide out top to bottom; returns the canvas, so a test can read it without saving anything. */
export function drawNightPicture(slide: PictureSlide, look: { heading: string; fill: string; ink: string }) {
	const canvas = document.createElement('canvas');
	canvas.width = W;
	canvas.height = H;
	const g = canvas.getContext('2d');
	if (!g) throw new Error('no 2d canvas');
	g.fillStyle = look.fill;
	g.fillRect(0, 0, W, H);
	g.fillStyle = look.ink;
	g.textBaseline = 'alphabetic';
	const measure = (t: string) => g.measureText(t).width;
	const text = (
		s: string,
		size: number,
		weight: number,
		y: number,
		{ alpha = 1, align = 'left' as CanvasTextAlign, max = W - 2 * PAD } = {}
	) => {
		g.globalAlpha = alpha;
		g.font = `${weight} ${size}px ${FONT}`;
		g.textAlign = align;
		g.fillText(fitText(s, max, measure), align === 'right' ? W - PAD : PAD, y);
		g.globalAlpha = 1;
		return measure(fitText(s, max, measure));
	};
	text(look.heading, 36, 700, PAD + 20, { alpha: 0.8 });
	let y = 440;
	text(slide.kick, 48, 700, y, { alpha: 0.8 });
	if (slide.big) {
		y += 190;
		text(slide.big, 180, 800, y);
	}
	for (const [title, detail] of capRows(slide.rows ?? [])) {
		y += 96;
		g.globalAlpha = 0.18;
		g.fillRect(PAD, y - 64, W - 2 * PAD, 4);
		g.globalAlpha = 1;
		// The detail first, so the title gets exactly the width it leaves.
		const detailW = detail ? text(detail, 40, 600, y, { alpha: 0.8, align: 'right' }) + GAP : 0;
		text(title, 44, 700, y, { max: W - 2 * PAD - detailW });
	}
	for (const s of slide.sub) {
		y += 80;
		text(s, 44, 600, y, { alpha: 0.8 });
	}
	if (slide.song) {
		g.font = `800 64px ${FONT}`;
		for (const line of wrapText(slide.song, W - 2 * PAD, measure)) {
			y += 84;
			text(line, 64, 800, y);
		}
	}
	for (const s of slide.after ?? []) {
		y += 80;
		text(s, 44, 600, y, { alpha: 0.8 });
	}
	text('Encore', 36, 800, H - PAD, { alpha: 0.8 });
	return canvas;
}

export async function saveNightPicture(slide: PictureSlide, look: { heading: string; fill: string; ink: string }) {
	const canvas = drawNightPicture(slide, look);
	const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
	if (!blob) throw new Error('no picture');
	const file = new File([blob], 'my-night.png', { type: 'image/png' });
	if (window.isSecureContext && navigator.canShare?.({ files: [file] })) {
		// Closing the share sheet is a choice, not a failure.
		await navigator.share({ files: [file] }).catch((e: unknown) => {
			if ((e as DOMException)?.name !== 'AbortError') throw e;
		});
		return;
	}
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = 'my-night.png';
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
