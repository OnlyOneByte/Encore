// The ONE wording for whose turn it is, read by the TV's cards, the phone's /queue and its "You're up" sheet. The TV once
// said "Next up", "Up next" and "Loading" for the same singer while the phone said "Singing now" (UI-12): screens
// that name one moment three ways contradict each other.

/** The singer whose song is playing (or starting) now. */
export const NOW_SINGING = 'Now singing';
/** The singer after that. */
export const UP_NEXT = 'Up next';
/** My On deck went to someone else and I did not cause it (proposal 14). Names who goes first, never who moved it. */
export function deckBumpNotice(onDeck: string, youreNext: boolean): string {
	return `${onDeck}’s going first. ${youreNext ? 'You’re next.' : 'Your key is saved.'}`;
}
/** The phone's own word for the moment the room's current song becomes yours. */
export const YOURE_UP = 'You’re up';
