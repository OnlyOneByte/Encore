// Singer accent palette — shared so the /join picker and every surface use the same set.
// Each singer picks one; it's their identity color across phone + TV.
export const SINGER_COLORS = [
	'#7c5cff', // violet (accent)
	'#ff5cae', // pink (accent2)
	'#33d6a6', // green (ok)
	'#ffb84d', // amber (warn)
	'#5cb8ff', // sky
	'#ff7c5c', // coral
	'#b15cff', // purple
	'#5cffd6' // mint
] as const;

export type SingerColor = (typeof SINGER_COLORS)[number];

export function isValidColor(c: string): c is SingerColor {
	return (SINGER_COLORS as readonly string[]).includes(c);
}
