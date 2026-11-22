// "Your card comes to you" (proposal 13, 2/2): when your On deck heads-up or your failed song needs you and its
// first control sits under the dock, /queue scrolls that card up once. Pure, so a bun test can decide it. See
// routes/queue/+page.svelte.

/** A guest who touched or scrolled this recently is driving the page, and the page does not fight them. */
export const CARD_SCROLL_QUIET_MS = 3_000;

export interface CardGeometry {
	/** The card's top and its first control's bottom, in viewport px. */
	cardTop: number;
	controlBottom: number;
	/** The sticky header's bottom and the fixed dock's top, in viewport px. */
	headerBottom: number;
	dockTop: number;
	scrollY: number;
	/** The gap left between the header and the card. */
	gap: number;
}

/** The scrollY that lands the card just below the header, or null when its first control is already reachable. */
export function cardScrollTarget(g: CardGeometry): number | null {
	if (g.controlBottom <= g.dockTop && g.cardTop >= g.headerBottom) return null;
	return Math.max(0, g.scrollY + g.cardTop - g.headerBottom - g.gap);
}

// MODULE scope, as `buzzOnce` in on-deck.ts: /queue unmounts on every tab switch, and the card comes up once per
// ENTRY, not once per visit to the tab.
const decided = new Set<string>();
/** True the first time it is asked about this entry, false ever after. */
export function firstTimeFor(entryId: string): boolean {
	if (decided.has(entryId)) return false;
	decided.add(entryId);
	return true;
}

/** Whether the guest's last touch, wheel or key was too recent to move the page under them. */
export function guestIsDriving(lastInputMs: number | null, nowMs: number): boolean {
	return lastInputMs !== null && nowMs - lastInputMs < CARD_SCROLL_QUIET_MS;
}
