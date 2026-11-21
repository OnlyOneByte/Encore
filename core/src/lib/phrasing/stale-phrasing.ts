// What a phone says when the server dropped one of ITS commands as stale (`player:stale`). Per command, because
// the moment differs: a skip or restart that named the last song arrives while the strip already shows the new
// one (`$lib/transport-target` keeps the strip naming the last song for a second), so "That song already ended."
// read as wrong there. A key or guide change was made on a card that still showed the old song, and for those it
// is the plain truth. Guest words, straight apostrophes.
import type { TargetedCommand } from '$lib/contract';

const STALE: Record<TargetedCommand['cmd'], string> = {
	skip: 'Already skipped. Tap again to skip this one too.',
	restart: 'New song just started. Tap again to restart it.',
	seek: 'That song already ended.',
	key: 'That song already ended.',
	guide: 'That song already ended.'
};

export function staleNotice(cmd: TargetedCommand['cmd']): string {
	return STALE[cmd];
}
