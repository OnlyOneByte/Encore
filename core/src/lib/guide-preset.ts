import { clampGuideLevel } from '$lib/contract/lyrics/guide-level';

// shortcut: Low's 0.3 is a default, not an owner ruling; change it here when one lands.
export const GUIDE_PRESETS = [
	{ id: 'off', label: 'Off', level: 0 },
	{ id: 'low', label: 'Low', level: 0.3 },
	{ id: 'full', label: 'Full', level: 1 }
] as const;

export type GuidePresetId = (typeof GUIDE_PRESETS)[number]['id'];

/** The preset a level IS, or null for a level the song page's slider set between them: no segment may claim it. */
export function guidePresetOf(level: number | null | undefined): GuidePresetId | null {
	const l = clampGuideLevel(level);
	if (l === null) return null;
	return GUIDE_PRESETS.find((p) => p.level === l)?.id ?? null;
}
