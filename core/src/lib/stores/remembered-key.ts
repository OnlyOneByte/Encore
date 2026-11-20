// The key this PHONE last sang a song in, so a repeat song is queued already set. Per phone on purpose: the server
// keeps no singer-to-song history (`plays` is singer-free, server/db/schema.ts), and this must not start one.

import { clampKeyShift } from '$lib/contract';

const keyFor = (mediaId: string) => `encore:key:${mediaId}`;

// Injectable, and every access guarded: storage can throw in a sandboxed or private-mode context, and a remembered
// key is never load-bearing.
function storageOf(store?: Storage): Storage | null {
	if (store) return store;
	try {
		return typeof localStorage !== 'undefined' ? localStorage : null;
	} catch {
		return null;
	}
}

/** The remembered shift, or `undefined` for none (including a stored 0 or garbage). */
export function rememberedKey(mediaId: string, store?: Storage): number | undefined {
	try {
		const raw = storageOf(store)?.getItem(keyFor(mediaId));
		const n = raw == null ? NaN : Number(raw);
		return Number.isFinite(n) && clampKeyShift(n) !== 0 ? clampKeyShift(n) : undefined;
	} catch {
		return undefined;
	}
}

/** 0 forgets, so the original key needs no entry. */
export function rememberKey(mediaId: string, semitones: number, store?: Storage): void {
	try {
		const s = storageOf(store);
		const k = clampKeyShift(semitones);
		if (k === 0) s?.removeItem(keyFor(mediaId));
		else s?.setItem(keyFor(mediaId), String(k));
	} catch {
		// Quota or disabled storage: forgetting is the right degradation.
	}
}
