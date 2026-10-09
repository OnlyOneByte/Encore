/*
 * THE THREE SCOPES OF SETTINGS, and what a write to each one costs: You is one person, The party is this room,
 * This machine is every room on this server. One home, because every half reads it — each scope ROUTE takes its
 * own heading and its own blast-radius line from here, every card header on that route marks its scope from the
 * same string, and the two cross-links between scopes spell their hrefs from it. Two hand-kept copies of this
 * list drifted once already, into a guard whose job was to notice.
 *
 * KEYED, NOT ORDERED, which is the shape change from the `SETTINGS_TABS` array this replaces: there is no tablist
 * any more, so nothing iterates the three in a row. The route IS the scope, so each reader wants exactly one of
 * them by name.
 *
 * `blastRadius` carries NO terminal stop, because it is spelled in two registers from this one string: the scope
 * line under a page's heading renders it as a sentence and supplies the stop, and the per-card eyebrow renders it
 * uppercased by CSS, where a full stop reads as a typo.
 */
export interface SettingsScope {
	/** The page heading. Names the scope, not the word "Settings" — the gear is the door, this is the place. */
	label: string;
	/** Who a write here reaches. Sentence case, no terminal stop. */
	blastRadius: string;
	/** The one address for this scope. `/settings` IS the room scope, so a gear tap still costs one tap. */
	href: string;
}

export const SETTINGS_SCOPES = {
	you: { label: 'You', blastRadius: 'Only you see this', href: '/settings/you' },
	room: { label: 'The party', blastRadius: 'Everyone in this room', href: '/settings' },
	server: { label: 'This machine', blastRadius: 'Every room on this server', href: '/settings/server' }
} as const satisfies Record<string, SettingsScope>;
