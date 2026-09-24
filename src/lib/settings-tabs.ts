// The three scopes of /settings, in the order they are shown: You is one person, Party is this room, Server is the
// machine. ONE list, because the ids are read on both sides of the load — the server resolves `?tab=` so the first
// paint is already the right panel, and the page renders a trigger and a panel per id. Two hand-kept copies drifted
// into a guard whose job was to notice, which is a cross-check standing in for a shared constant.
export const SETTINGS_TABS = [
	{ id: 'you', label: 'You' },
	{ id: 'party', label: 'Party' },
	{ id: 'server', label: 'Server' }
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id'];

/* Party, not Server: server-wide settings are set once and then left alone, while the rotation is changed mid-song.
   You is never the default — landing there would answer a question the guest did not ask. */
export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'party';

/** Narrows an untrusted `?tab=` to a real scope, so a bad value paints the default rather than an empty page. */
export function settingsTabFromParam(requested: string | null | undefined): SettingsTabId {
	return SETTINGS_TABS.some((tab) => tab.id === requested) ? (requested as SettingsTabId) : DEFAULT_SETTINGS_TAB;
}
