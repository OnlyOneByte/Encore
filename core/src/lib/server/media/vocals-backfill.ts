// Gives an ALREADY-PROCESSED song its vocals ref when the stem file is on disk but the ref was never
// recorded. Runs off the FILESYSTEM alone: no cpu, no downloads, no worker.
//
// Refuses to link a SILENT stem: a ref set on existence alone advertises a guiding track that plays
// nothing, which is worse than offering none because it looks like it works.
//  PURE selector plus injected IO, so the policy tests without a disk or a probe.

import type { Media } from '../../contract';
import { vocalsKey, legacyVocalsRefs } from './paths';

/** An unprocessed song gets its ref through the normal `job:complete` path; one that already has a ref is
 *  skipped, since this pass never re-probes settled work. */
export function needsVocalsBackfill(catalog: Iterable<Media>): string[] {
	const out: string[] = [];
	for (const m of catalog) {
		if (m.stemStatus !== 'ready' || !m.instrumentalRef) continue;
		if (m.vocalsRef) continue;
		out.push(m.id);
	}
	return out;
}

/** Best guess first. An older layout's vocals file is the instrumental ref's same-name sibling, so
 *  deriving only the modern key would silently miss it. */
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
	/** `'unknown'` (the probe could not run) is deliberately DISTINCT from `'audible'`: the same action
	 *  follows either way, but the operator needs to know which happened. */
	measure(absPath: string): Promise<'audible' | 'silent' | 'unknown'>;
	/** Record the ref on the media (runtime map + durable index). */
	link(mediaId: string, ref: string): void;
}

export interface VocalsBackfillResult {
	/** Songs that gained a guiding track after measuring as audible. */
	linked: number;
	/** Exists but is digital silence — deliberately NOT linked. */
	silent: number;
	/** No vocals file at all. */
	missing: number;
	/** Linked WITHOUT being measured. Counted apart from `linked`, because a box with no ffmpeg still
	 *  deserves a guiding track but an operator reading "linked" would be told something false. */
	unmeasured: number;
}

/** Existence AND loudness, IN THAT ORDER: the probe is the expensive half. */
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
