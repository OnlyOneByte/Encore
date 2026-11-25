// "Your night" (proposal 29 PR 3): which slides a night's own turns can truthfully show. Pure, so every "shown only
// when true" rule is a unit test. One person's turns only, so nothing here can compare singers (no rankings).

export interface StoryTurn {
	title: string | null;
	startedAt: number;
	end: 'finished' | 'skipped' | 'failed';
	keyShift: number;
	cheers: number;
}

export type Slide =
	| { kind: 'cover'; songs: number }
	| { kind: 'loudest'; cheers: number; title: string; ofSeveral: boolean }
	| { kind: 'setlist'; rows: { title: string; cheers: number; keyShift: number }[]; keyLine: string | null };

const titleOf = (t: StoryTurn) => t.title ?? 'A song';

/** "You like it 2 keys down" when more than half the songs were shifted, by the shift used most (ties: the smaller). */
export function keyLine(turns: readonly StoryTurn[]): string | null {
	const shifted = turns.filter((t) => t.keyShift !== 0);
	if (shifted.length * 2 <= turns.length) return null;
	const counts = new Map<number, number>();
	for (const t of shifted) counts.set(t.keyShift, (counts.get(t.keyShift) ?? 0) + 1);
	const [shift] = [...counts].sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))[0]!;
	const n = Math.abs(shift);
	return `You like it ${n} ${n === 1 ? 'key' : 'keys'} ${shift < 0 ? 'down' : 'up'}.`;
}

/** "3rd night in a row" on the cover, from two nights in a row up; one night on its own is no streak. */
export function streakLine(streak: number): string | null {
	if (streak < 2) return null;
	const teen = streak % 100 >= 11 && streak % 100 <= 13;
	const suffix = teen ? 'th' : (['th', 'st', 'nd', 'rd'][streak % 10] ?? 'th');
	return `${streak}${suffix} night in a row`;
}

/** The songs you sang: a turn that failed before anyone heard it is not one. */
export function sung(turns: readonly StoryTurn[]): StoryTurn[] {
	return turns.filter((t) => t.end !== 'failed');
}

export function nightStory(all: readonly StoryTurn[]): Slide[] {
	const turns = sung(all);
	if (turns.length === 0) return [];
	const slides: Slide[] = [{ kind: 'cover', songs: turns.length }];
	// The first of the loudest when two tie: the earlier song had the room first.
	const loudest = turns.reduce((best, t) => (t.cheers > best.cheers ? t : best));
	if (loudest.cheers > 0)
		slides.push({ kind: 'loudest', cheers: loudest.cheers, title: titleOf(loudest), ofSeveral: turns.length > 1 });
	slides.push({
		kind: 'setlist',
		rows: turns.map((t) => ({ title: titleOf(t), cheers: t.cheers, keyShift: t.keyShift })),
		keyLine: keyLine(turns)
	});
	return slides;
}

/** "37 cheers · key −2", or just the half that is true. */
export function setlistDetail(row: { cheers: number; keyShift: number }): string {
	const parts: string[] = [];
	if (row.cheers > 0) parts.push(`${row.cheers} ${row.cheers === 1 ? 'cheer' : 'cheers'}`);
	if (row.keyShift !== 0) parts.push(`key ${row.keyShift > 0 ? '+' : '−'}${Math.abs(row.keyShift)}`);
	return parts.join(' · ');
}
