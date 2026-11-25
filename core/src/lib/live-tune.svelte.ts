// The singer's live key and guide on the playing song, shared by /queue's card and the You're up flood (redesign
// step 6). Call it during a component's init: its effects belong to that component.

import { MAX_KEY_SHIFT } from '$lib/contract';
import { room } from '$lib/stores/room';
import { rememberKey } from '$lib/stores/remembered-key';

export interface LiveTuneSource {
	/** The playing entry, or null between songs. */
	entryId: string | null;
	mediaId: string | null;
	/** Whether the playing song is this phone's own: only then is its key remembered for the next time. */
	mine: boolean;
	/** The key the room last broadcast. */
	serverKey: number;
}

export function liveTune(read: () => LiveTuneSource) {
	/* AN OPTIMISTIC KEY: computing the next value from the last server echo loses every tap made before the echo
	   arrives (five fast taps sent 1, 1, 1, 1, 1). The draft moves the local view; the command still names an
	   ABSOLUTE target, so a dropped or repeated message is never a key that is permanently wrong. `null` means no
	   local opinion, so a change from the TV or another phone takes over at once. */
	let keyDraft = $state<number | null>(null);
	// Dropped the moment the server agrees with it.
	$effect(() => {
		if (keyDraft !== null && read().serverKey === keyDraft) keyDraft = null;
	});
	/* And when the song changes, keyed on the entry ID: a skip goes straight from one entry to the next, never through
	   null, so the next singer's card would otherwise show this one's "+1". */
	let draftsFor: string | null | undefined;
	$effect(() => {
		const id = read().entryId;
		if (id === draftsFor) return;
		draftsFor = id;
		keyDraft = null;
	});

	const keyShift = () => keyDraft ?? read().serverKey;
	return {
		get keyShift() {
			return keyShift();
		},
		stepKey(delta: number): void {
			const now = keyShift();
			const next = Math.max(-MAX_KEY_SHIFT, Math.min(MAX_KEY_SHIFT, now + delta));
			if (next === now) return;
			const { entryId, mediaId, mine } = read();
			// The key is per-song, so it names the song: a tap that lands after a skip must not re-pitch the next one.
			if (!entryId) return;
			// THE DRAFT ONLY MOVES IF THE COMMAND LEFT: offline, a draft the server never heard would stick.
			if (!room.command({ cmd: 'key', semitones: next, entryId })) return;
			keyDraft = next;
			if (mine && mediaId) rememberKey(mediaId, next);
		},
		/* One pick, one command naming the song, so a pick after a skip is dropped as stale. Hands back whether it
		   left, so GuideSegments drops a pick that never reached the wire. */
		guidePick(level: number): boolean {
			const { entryId } = read();
			if (!entryId) return false;
			return room.command({ cmd: 'guide', level, entryId });
		}
	};
}
