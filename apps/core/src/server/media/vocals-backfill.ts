// Guiding-track backfill — give ALREADY-COOKED songs their vocals ref.
//
// WHY THIS EXISTS. Separation has been writing a vocals stem next to the instrumental for a long
// time, but the core dropped the ref on the floor, so every song cooked before that was fixed has a
// perfectly good file on disk that nothing can find. Re-cooking is the only other route and nobody
// re-cooks a working song — the same trap the lyrics backfill was written for. On the owner's live
// library that is seven of nine cooked songs gaining a guiding track for ZERO cpu, zero downloads,
// and no worker at all: this pass only looks at the filesystem.
//
// It also refuses to link a SILENT stem. Two of those nine songs are the silent-stem defect (both
// stems pinned at the 16-bit floor), and a ref set on existence alone would advertise a guiding
// track that plays nothing — worse than offering none, because it looks like it works.
//
// PURE selector + injected IO, like backfill.ts and retention.ts, so the policy is testable without
// a disk or a probe.

import type { Media } from '@encore/shared';
import { vocalsKey, legacyVocalsRefs } from './paths';

/**
 * Cooked songs that could have a guiding track but have no ref for it yet.
 *
 * Only cooked songs: the vocals stem is a product of separation, and an uncooked song will get its
 * ref through the normal `job:complete` path when someone cooks it. A song that already has a ref is
 * skipped — this pass never re-probes settled work.
 */
export function needsVocalsBackfill(catalog: Iterable<Media>): string[] {
	const out: string[] = [];
	for (const m of catalog) {
		if (m.stemStatus !== 'ready' || !m.instrumentalRef) continue;
		if (m.vocalsRef) continue;
		out.push(m.id);
	}
	return out;
}

/**
 * Every ref a media's vocals stem might live at, best guess first.
 *
 * The legacy shape matters: songs cooked under the older layout have an instrumental ref whose
 * sibling vocals file follows the same name, and retention.ts already carries this exact
 * `-instrumental.` → `-vocals.` substitution for the same reason. Deriving only the modern key would
 * silently miss those songs.
 */
export function candidateVocalsRefs(m: Media): string[] {
	const refs = [vocalsKey(m.id), ...(m.instrumentalRef ? legacyVocalsRefs(m.instrumentalRef) : [])].filter(
		(r): r is string => !!r
	);
	return [...new Set(refs)];
}

export interface VocalsBackfillIO {
	/** Resolve a ref to an absolute path, or null if it escapes the media root. */
	resolve(ref: string): string | null;
	/** Does the file exist on disk? */
	exists(absPath: string): boolean;
	/**
	 * Measure the file. `'unknown'` means the probe could not run at all (no ffmpeg) — deliberately
	 * distinct from `'audible'`, because the two justify the same ACTION but are very different
	 * operational facts and the operator needs to be told which one happened.
	 */
	measure(absPath: string): Promise<'audible' | 'silent' | 'unknown'>;
	/** Record the ref on the media (runtime map + durable index). */
	link(mediaId: string, ref: string): void;
}

export interface VocalsBackfillResult {
	/** Songs that gained a guiding track after measuring as audible. */
	linked: number;
	/** Songs whose vocals stem exists but is digital silence — deliberately NOT linked. */
	silent: number;
	/** Songs with no vocals file at all (cooked before the stem was published). */
	missing: number;
	/**
	 * Linked WITHOUT being measured, because no probe was available.
	 *
	 * These are counted apart from `linked` rather than hidden inside it. Refusing to link when the
	 * probe cannot run would mean a box with no ffmpeg offers no guiding track at all, which is far
	 * worse than trusting a file the worker already wrote — but an operator reading "linked 4" when
	 * two of the four are silent has been told something false. So: link, and say so.
	 */
	unmeasured: number;
}

/**
 * Link the vocals stem for every cooked song missing one. Existence AND loudness, in that order —
 * the probe is the expensive half, so it only runs on a file that is actually there.
 */
export async function backfillVocalsRefs(
	catalog: Iterable<Media>,
	io: VocalsBackfillIO
): Promise<VocalsBackfillResult> {
	const res: VocalsBackfillResult = { linked: 0, silent: 0, missing: 0, unmeasured: 0 };
	const byId = new Map<string, Media>();
	for (const m of catalog) byId.set(m.id, m);

	for (const id of needsVocalsBackfill(byId.values())) {
		const m = byId.get(id);
		if (!m) continue;
		let found: { ref: string; abs: string } | null = null;
		for (const ref of candidateVocalsRefs(m)) {
			const abs = io.resolve(ref);
			if (abs && io.exists(abs)) {
				found = { ref, abs };
				break;
			}
		}
		if (!found) {
			res.missing++;
			continue;
		}
		const verdict = await io.measure(found.abs);
		if (verdict === 'silent') {
			res.silent++;
			continue;
		}
		io.link(id, found.ref);
		if (verdict === 'unknown') res.unmeasured++;
		else res.linked++;
	}
	return res;
}
