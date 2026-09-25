// Lets a worker on a SECOND box reach media the core can: `local` (shared volume) or `object` (S3/MinIO),
// flipped via env var and carried in `worker:welcome`. A STORE ANSWERS BYTES, NOT URLS — every ref reaches a
// client through the same-origin `/media/<ref>` route. Do NOT re-add a `url(ref)`/presigned member: the
// same-origin guarantee is depended on elsewhere, and cross-origin media is a product decision.

import type { MediaStoreConfig } from '../../contract';
import { safeMediaPath } from './local-files';

export type MediaStoreKind = MediaStoreConfig['kind'];
// The object-store half of the shared union, narrowed for local use (S3/MinIO connection config).
export type ObjectStoreConfig = Extract<MediaStoreConfig, { kind: 'object' }>;
export type { MediaStoreConfig };

/** PURE: takes the env bag, not process.env. `MEDIA_STORE=object` requires S3_BUCKET, and a missing bucket
 *  FALLS BACK to local with no throw — the party must still run single-box. */
export function resolveMediaStoreConfig(env: Record<string, string | undefined>): MediaStoreConfig {
	if ((env.MEDIA_STORE ?? 'local').toLowerCase() !== 'object') return { kind: 'local' };
	const bucket = env.S3_BUCKET?.trim();
	if (!bucket) return { kind: 'local' }; // flag set but unusable → safe default
	return {
		kind: 'object',
		bucket,
		endpoint: env.S3_ENDPOINT?.trim() || undefined,
		region: env.S3_REGION?.trim() || undefined,
		prefix: normalizePrefix(env.S3_PREFIX)
	};
}

/** Normalize a key prefix: trim, drop leading '/', ensure a single trailing '/', or '' if empty. */
export function normalizePrefix(prefix: string | undefined): string | undefined {
	const p = prefix?.trim().replace(/^\/+/, '').replace(/\/+$/, '');
	return p ? `${p}/` : undefined;
}

/** The full object key for a media ref under the configured prefix (e.g. "encore/stems/m1.wav"). */
export function objectKey(prefix: string | undefined, ref: string): string {
	return `${prefix ?? ''}${ref}`;
}

/** Bytes only: the same-origin `/media` route is the sole URL builder. */
export interface MediaStore {
	readonly kind: MediaStoreKind;
	/** Does this ref exist in the store? */
	exists(ref: string): Promise<boolean>;
	/** Used by the /media proxy for object stores; the worker pulls the source itself. */
	get(ref: string): Promise<ReadableStream | null>;
	/** OPTIONAL: `/media` serves byte ranges only for a store answering both this and `getRange`, else
	 *  degrades to a plain `200`. Range support is what makes a media element seekable — and WebKit play. */
	size?(ref: string): Promise<number | null>;
	/** INCLUSIVE, already validated against real size by the caller. SHOULD return a `Blob`, not a stream:
	 *  a Blob-built Response carries `Content-Length`, so a media element knows the size up front. */
	getRange?(ref: string, start: number, end: number): Promise<ReadableStream | Blob | null>;
	/** Write bytes (the worker pushes stems/lyrics). */
	put(ref: string, data: Uint8Array | ReadableStream | Blob): Promise<void>;
}

/** The default. Wraps the safeMediaPath guard plus Bun.file. */
export class LocalMediaStore implements MediaStore {
	readonly kind = 'local' as const;

	#abs(ref: string): string | null {
		return safeMediaPath(ref);
	}

	async exists(ref: string): Promise<boolean> {
		const abs = this.#abs(ref);
		return abs ? Bun.file(abs).exists() : false;
	}

	async get(ref: string): Promise<ReadableStream | null> {
		const abs = this.#abs(ref);
		if (!abs) return null;
		const file = Bun.file(abs);
		return (await file.exists()) ? file.stream() : null;
	}

	/** `BunFile` is a `Blob`, so the size is a stat away — no read. Null for absent/unsafe refs. */
	async size(ref: string): Promise<number | null> {
		const abs = this.#abs(ref);
		if (!abs) return null;
		const file = Bun.file(abs);
		return (await file.exists()) ? file.size : null;
	}

	/** A Blob, so the response carries `Content-Length`. `Blob.slice` is EXCLUSIVE-end where HTTP ranges are
	 *  inclusive, hence `end + 1`: getting it wrong drops the final byte of every chunk. */
	async getRange(ref: string, start: number, end: number): Promise<Blob | null> {
		const abs = this.#abs(ref);
		if (!abs) return null;
		const file = Bun.file(abs);
		if (!(await file.exists())) return null;
		return file.slice(start, end + 1);
	}

	async put(ref: string, data: Uint8Array | ReadableStream | Blob): Promise<void> {
		const abs = this.#abs(ref);
		if (!abs) throw new Error(`unsafe media ref: ${ref}`);
		await Bun.write(abs, data as Blob);
	}
}
