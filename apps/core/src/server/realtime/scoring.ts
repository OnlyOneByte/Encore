// Scoring engine (I/O half). Turns incoming mic:pitch samples into score:update broadcasts:
// resolves the current song, loads its reference pitch track (cached), feeds a per-entry
// SessionScorer, and publishes the running score. The reference-doc loader is INJECTED so this
// unit-tests with a fake loader + publish sink (no MediaStore, no sockets).
import type { Media, ServerEvent } from '@encore/shared';
import type { AuthoritativeState } from '../state/store';
import { SessionScorer, type RefPitchDoc } from '../scoring/scorer';

// Load a reference pitch doc by its MediaStore key (async — reads the MediaStore in prod).
export type PitchDocLoader = (pitchRef: string) => Promise<RefPitchDoc | null>;

export interface ScoreDeps {
	state: AuthoritativeState;
	mediaById: Map<string, Media>;
	publish: (e: ServerEvent) => void;
	loadDoc: PitchDocLoader;
}

export class ScoreEngine {
	#scorers = new Map<string, SessionScorer>(); // per entryId — a fresh score per performance
	#docs = new Map<string, RefPitchDoc | null>(); // per pitchRef (null = load failed / no doc)
	#loading = new Set<string>();

	/** Seed a parsed doc directly (preload on nowplaying:changed, or tests) — avoids a lazy miss. */
	primeDoc(pitchRef: string, doc: RefPitchDoc | null): void {
		this.#docs.set(pitchRef, doc);
	}

	/**
	 * Handle one mic:pitch sample. No-ops (no score:update) when there's no current song, the song
	 * has no reference pitch track, or its doc hasn't loaded yet (the first sample kicks off the
	 * async load and is skipped — subsequent samples score once it lands).
	 */
	handleMicPitch(sample: { positionSec: number; f0Hz: number }, deps: ScoreDeps): void {
		const cur = deps.state.entries.find((e) => e.id === deps.state.playback.currentEntryId);
		if (!cur) return;
		const ref = deps.mediaById.get(cur.mediaId)?.pitchRef;
		if (!ref) return; // song wasn't scored (no reference) → nothing to compare against

		const doc = this.#docs.get(ref);
		if (doc === undefined) {
			this.#ensureLoaded(ref, deps); // not loaded yet — kick off, skip this sample
			return;
		}
		if (doc === null) return; // load failed / absent

		let scorer = this.#scorers.get(cur.id);
		if (!scorer) {
			scorer = new SessionScorer();
			this.#scorers.set(cur.id, scorer);
		}
		scorer.ingest(doc, sample.positionSec, sample.f0Hz);
		deps.publish({
			type: 'score:update',
			entryId: cur.id,
			singerId: cur.singerId,
			score: scorer.score,
			hits: scorer.hits,
			total: scorer.total
		});
	}

	#ensureLoaded(ref: string, deps: ScoreDeps): void {
		if (this.#loading.has(ref)) return;
		this.#loading.add(ref);
		deps
			.loadDoc(ref)
			.then((doc) => this.#docs.set(ref, doc))
			.catch(() => this.#docs.set(ref, null))
			.finally(() => this.#loading.delete(ref));
	}
}
