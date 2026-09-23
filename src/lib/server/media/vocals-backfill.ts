// Guiding-track backfill — give ALREADY-PROCESSED songs their vocals ref, for songs whose stem file
// already exists on disk but whose ref was never recorded (a fixed bug, not something worth
// re-processing a working song over — the same trap the lyrics backfill was written for). Runs off
// the filesystem alone: zero cpu, zero downloads, no worker.
//
// Refuses to link a SILENT stem: a ref set on existence alone would advertise a guiding track that
// plays nothing, worse than offering none because it looks like it works.
//
// PURE selector + injected IO, like backfill.ts and retention.ts, so the policy is testable without
// a disk or a probe.

import type { Media } from '../../contract';
import { vocalsKey, legacyVocalsRefs } from './paths';

/** Processed songs that could have a guiding track but have no ref for it yet — an unprocessed song
 *  gets its ref through the normal `job:complete` path instead; one that already has a ref is
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

/**
 * Every ref a media's vocals stem might live at, best guess first. Songs from the older layout have
 * an instrumental ref whose sibling vocals file shares the same name (the same
 * `-instrumental.` → `-vocals.` substitution retention.ts uses) — deriving only the modern key would
 * silently miss them.
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
	/** Measure the file. `'unknown'` (probe couldn't run, e.g. no ffmpeg) is deliberately distinct
	 *  from `'audible'` — same ACTION follows either way, but the operator needs to know which happened. */
	measure(absPath: string): Promise<'audible' | 'silent' | 'unknown'>;
	/** Record the ref on the media (runtime map + durable index). */
	link(mediaId: string, ref: string): void;
}

export interface VocalsBackfillResult {
	/** Songs that gained a guiding track after measuring as audible. */
	linked: number;
	/** Songs whose vocals stem exists but is digital silence — deliberately NOT linked. */
	silent: number;
	/** Songs with no vocals file at all (processed before the stem was published). */
	missing: number;
	/** Linked WITHOUT being measured (no probe available) — counted apart from `linked` rather than
	 *  folded into it, since a box with no ffmpeg still deserves a guiding track, but an operator
	 *  reading "linked" for an unverified file would be told something false. */
	unmeasured: number;
}

/** Link the vocals stem for every processed song missing one. Existence AND loudness, in that
 *  order — the probe is the expensive half, so it only runs on a file that's actually there. */
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
