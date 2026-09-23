// MediaStore — lets a worker on a SECOND box read/write media the core can also reach: `local`
// (shared volume, single-box) or `object` (S3/MinIO, scale-out), flipped via env var;
// `worker:welcome` carries the resolved config. A STORE ANSWERS BYTES, NOT URLS: every ref reaches a
// client through the same-origin `/media/<ref>` route. Do not re-add a `url(ref)`/presigned-URL
// member — the same-origin guarantee is depended on elsewhere, and cross-origin media is a product
// decision, not a store detail.

import type { MediaStoreConfig } from '../../contract';
import { safeMediaPath } from './local-files';

export type MediaStoreKind = MediaStoreConfig['kind'];
// The object-store half of the shared union, narrowed for local use (S3/MinIO connection config).
export type ObjectStoreConfig = Extract<MediaStoreConfig, { kind: 'object' }>;
export type { MediaStoreConfig };

/**
 * Resolve the MediaStore config from env (PURE — takes the env bag, not process.env, so testable).
 * `MEDIA_STORE=object` requires S3_BUCKET; anything else, or a missing bucket, FALLS BACK to local
 * with no throw — the party must still run single-box even if the flag is set without a bucket.
 */
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

/** What every store can do. Bytes only — the same-origin `/media` route is the sole URL builder. */
export interface MediaStore {
	readonly kind: MediaStoreKind;
	/** Does this ref exist in the store? */
	exists(ref: string): Promise<boolean>;
	/** Read the bytes (used by the /media proxy for object stores; the worker pulls the source). */
	get(ref: string): Promise<ReadableStream | null>;
	/**
	 * Byte size of the object, or null when absent/unknown. OPTIONAL: `/media` serves HTTP byte
	 * ranges only for a store answering both this and `getRange`, else degrades to a plain `200` —
	 * range support is what makes a media element seekable, and what makes WebKit play at all (media/http-range.ts).
	 */
	size?(ref: string): Promise<number | null>;
	/**
	 * Read an INCLUSIVE byte range (already validated against real size by the caller). SHOULD
	 * return a `Blob` rather than a stream: a Blob-built Response carries `Content-Length`, so a
	 * media element knows the resource size without decoding to the end.
	 */
	getRange?(ref: string, start: number, end: number): Promise<ReadableStream | Blob | null>;
	/** Write bytes (the worker pushes stems/lyrics). */
	put(ref: string, data: Uint8Array | ReadableStream | Blob): Promise<void>;
}

/** Local volume store — the MVP default. Wraps the existing safeMediaPath guard + Bun.file. */
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

	/**
	 * A slice of the file, as a Blob so the response carries `Content-Length`. `Blob.slice` is
	 * EXCLUSIVE-end while HTTP ranges are inclusive, hence `end + 1` — getting this wrong drops the
	 * final byte of every chunk, read by a decoder as a corrupt stream.
	 */
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
