// What a phone says when the server dropped one of ITS commands as stale (`player:stale`), or null for nothing.
// Per command, because the moment differs: a skip or restart that named the last song arrives while the strip
// already shows the new one (`$lib/transport-target` keeps the strip naming the last song for a second), so "That
// song already ended." read as wrong there. A key or guide change was made on a card that still showed the old song,
// and for those it is the plain truth. So it is once the room has gone idle: no new song, so nothing to tap again
// for. Guest words, straight apostrophes, and the last two words joined by a no-break
// space (\u00a0) so no word sits alone on the second line at 390 or 320.
import type { TargetedCommand } from '$lib/contract';

const ENDED = 'That song already\u00a0ended.';

const STALE: Record<TargetedCommand['cmd'], string> = {
	skip: 'That song just ended. Tap again to skip this\u00a0one.',
	restart: 'A new song just started. Tap again to restart\u00a0it.',
	seek: ENDED,
	key: ENDED,
	guide: ENDED
};

/** The notice for a stale `cmd`, or null to say nothing. `ownTurn`: the song now current is this phone's. `idle`:
 *  no song is current. A skip that landed on this phone's own new turn says nothing: the tap got what it asked for,
 *  and "You're up" says the rest (integration-1, IN-02). Every other stale command is still told, own turn or not. */
export function staleNotice(
	cmd: TargetedCommand['cmd'],
	{ ownTurn, idle, singerOnly, singer }: { ownTurn: boolean; idle: boolean; singerOnly?: boolean; singer?: string }
): string | null {
	// Refused, not stale: someone else's song. "their", because the phone knows a name, never a pronoun.
	if (singerOnly && !idle)
		return `Only ${singer || 'the singer'} can change their\xa0${cmd === 'guide' ? 'guide' : 'key'}.`;
	if (idle) return ENDED;
	if (cmd === 'skip' && ownTurn) return null;
	return STALE[cmd];
}
