// The ONE wording for whose turn it is, read by the TV's cards, the phone's /queue and its "You're up" sheet. The TV once
// said "Next up", "Up next" and "Loading" for the same singer while the phone said "Singing now" (UI-12): screens
// that name one moment three ways contradict each other.

/** The singer whose song is playing (or starting) now. */
export const NOW_SINGING = 'Now singing';
/** A reorder stopped short of someone else's On deck (proposal 14). `after` is the moved song's singer, null for mine.
 *  Names, never a pronoun: the app does not know anyone's. */
export function onDeckHeldNote(onDeck: string, after: string | null): string {
	return `${onDeck}’s on deck. ${after === null ? 'You go' : `${after} goes`} right after.`;
}
/** The singer after that. */
export const UP_NEXT = 'Up next';
/** The TV's mid-song line after the next singer's name ("Theo is next"), where an "UP NEXT" eyebrow was. */
export const IS_NEXT = 'is next';
/** My On deck went to someone else and I did not cause it (proposal 14). Names who goes first, never who moved it. */
export function deckBumpNotice(onDeck: string, youreNext: boolean): string {
	return `${onDeck}’s going first. ${youreNext ? 'You’re next.' : 'Your key is saved.'}`;
}
/** The phone's own word for the moment the room's current song becomes yours. */
export const YOURE_UP = 'You’re up';
/** A turn the TV could not play, held in its slot until the singer acts (proposal 11). */
export const DIDNT_PLAY = 'Didn’t play';
/** The singer's own sheet for that turn, on any tab (proposal 11). */
export const YOUR_SONG_DIDNT_PLAY = 'Your song didn’t play';
/** Under its buttons: the turn is held, not lost. */
export const KEEP_YOUR_SPOT = 'You keep your spot.';
