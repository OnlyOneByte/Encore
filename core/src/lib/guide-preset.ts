import { clampGuideLevel } from '$lib/contract/lyrics/guide-level';

// Low 0.3 is the owner's accepted default and tunable here; change guide-preset.test.ts with it.
export const GUIDE_PRESETS = [
	{ id: 'off', label: 'Off', level: 0 },
	{ id: 'low', label: 'Low', level: 0.3 },
	{ id: 'full', label: 'Full', level: 1 }
] as const;

export type GuidePresetId = (typeof GUIDE_PRESETS)[number]['id'];

/** The preset nearest a level, for the segments: a room default between them (0.2) still shows one picked, so the
 *  control never reads as unset. A tie goes to the quieter one. */
export function nearestGuidePreset(level: number | null | undefined): GuidePresetId | null {
	const l = clampGuideLevel(level);
	if (l === null) return null;
	let best: (typeof GUIDE_PRESETS)[number] = GUIDE_PRESETS[0];
	for (const p of GUIDE_PRESETS) if (Math.abs(p.level - l) < Math.abs(best.level - l)) best = p;
	return best.id;
}

/** The preset a level IS, or null for a level the song page's slider set between them: no segment may claim it. */
export function guidePresetOf(level: number | null | undefined): GuidePresetId | null {
	const l = clampGuideLevel(level);
	if (l === null) return null;
	return GUIDE_PRESETS.find((p) => p.level === l)?.id ?? null;
}
