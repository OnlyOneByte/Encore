// "Tonight" on the TV: the room's night, from what the room saw. See docs/SERVER.md#tonight.

import type { Tonight, TonightSinger } from '../../contract';
import type { Performance } from './repository';
import { NIGHT_GAP_MS } from './repository';

export interface TonightInputs {
	/** Every play since a bound, oldest first: the singer-free log of what went on stage. */
	plays: { entryId: string; at: number }[];
	/** The recorded turns among those plays. */
	turns: Pick<Performance, 'entryId' | 'singerId' | 'personId' | 'mediaId' | 'startedAt' | 'end' | 'cheers'>[];
	/** Whether this turn's singer still keeps their nights. */
	keeps: (singerId: string, personId: string | null) => boolean;
	singer: (singerId: string) => TonightSinger | null;
	title: (mediaId: string) => string;
	now: number;
}

/** Tonight's plays: the run ending at the latest play with no 6-hour gap, and only if that play is within 6 hours. */
export function tonightPlays(plays: TonightInputs['plays'], now: number): TonightInputs['plays'] {
	if (plays.length === 0 || now - plays.at(-1)!.at >= NIGHT_GAP_MS) return [];
	let start = plays.length - 1;
	while (start > 0 && plays[start]!.at - plays[start - 1]!.at < NIGHT_GAP_MS) start--;
	return plays.slice(start);
}

/** Null when there is no night to show. A play with no recorded turn, or one whose singer no longer keeps their
 *  nights, is someone who must not be named or counted: then only the songs are totalled. */
export function buildTonight(inputs: TonightInputs): Tonight | null {
	const plays = tonightPlays(inputs.plays, inputs.now);
	if (plays.length === 0) return null;
	const byEntry = new Map(inputs.turns.map((t) => [t.entryId, t]));
	let hidden = false;
	let failed = 0;
	const shown: { entryId: string; turn: TonightInputs['turns'][number]; singer: TonightSinger }[] = [];
	for (const play of plays) {
		const turn = byEntry.get(play.entryId);
		// A song that wouldn't play is not one the room heard, whoever's it was: checked before who may be named.
		if (turn?.end === 'failed') {
			failed++;
			continue;
		}
		const singer = turn && inputs.keeps(turn.singerId, turn.personId) ? inputs.singer(turn.singerId) : null;
		if (!turn || !singer) {
			hidden = true;
			continue;
		}
		shown.push({ entryId: play.entryId, turn, singer });
	}
	const songs = plays.length - failed;
	if (songs === 0) return null;

	const firstPlay = plays.find((p) => byEntry.get(p.entryId)?.end !== 'failed');
	const lastPlay = plays.findLast((p) => byEntry.get(p.entryId)?.end !== 'failed');
	const song = (entryId: string | undefined) => {
		const s = shown.find((x) => x.entryId === entryId);
		return s ? { title: inputs.title(s.turn.mediaId), singer: s.singer } : undefined;
	};
	const everyone: TonightSinger[] = [];
	const seen = new Set<string>();
	for (const s of shown)
		if (!seen.has(s.turn.singerId)) {
			seen.add(s.turn.singerId);
			everyone.push(s.singer);
		}

	return {
		songs,
		...(hidden ? {} : { singers: seen.size, cheers: shown.reduce((n, s) => n + s.turn.cheers, 0) }),
		// The first or last song is named only when it really was the night's first or last.
		first: song(firstPlay?.entryId),
		last: songs > 1 ? song(lastPlay?.entryId) : undefined,
		everyone
	};
}
