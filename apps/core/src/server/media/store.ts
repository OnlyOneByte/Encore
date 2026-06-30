// MediaStore — the abstraction that lets a worker on a SECOND box read/write media the core can
// also reach (MASTER-DESIGN §2: "MediaStore is an interface — local volume (default) or object-
// store (MinIO/S3) when workers are remote. Flip via env var."). Single-box mode = `local` (a
// shared volume); scale-out = `object` (S3/MinIO). The `worker:welcome` handshake carries the
// resolved config so a remote worker knows where to pull the source / push stems.
//
// Bun 1.3 has native S3 (Bun.s3 / Bun.S3Client) — no aws-sdk/minio dep, and it speaks to MinIO via
// a custom `endpoint`. Reads/writes are injectable (see ObjectMediaStore) so this unit-tests with
// no network. The pure config resolver (resolveMediaStoreConfig) is the env→config seam.

import type { MediaStoreConfig } from '@encore/shared';
import { safeMediaPath } from './local-files';

export type MediaStoreKind = MediaStoreConfig['kind'];
// The object-store half of the shared union, narrowed for local use (S3/MinIO connection config).
export type ObjectStoreConfig = Extract<MediaStoreConfig, { kind: 'object' }>;
export type { MediaStoreConfig };

/**
 * Resolve the MediaStore config from env (PURE — takes the env bag, no process.env read, so it's
 * testable). MEDIA_STORE=object requires S3_BUCKET; anything else (incl. the default) → local.
 * A misconfigured `object` (no bucket) FALLS BACK to local with no throw — the party must still
 * run single-box even if someone sets the flag without the bucket.
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

/** What every store can do. `url(ref)` is how the TV resolves a playable source for a Media. */
export interface MediaStore {
	readonly kind: MediaStoreKind;
	/** Does this ref exist in the store? */
	exists(ref: string): Promise<boolean>;
	/** Read the bytes (used by the /media proxy for object stores; the worker pulls the source). */
	get(ref: string): Promise<ReadableStream | null>;
	/** Write bytes (the worker pushes stems/lyrics). */
	put(ref: string, data: Uint8Array | ReadableStream | Blob): Promise<void>;
	/**
	 * The URL the TV `<video>` should load for this ref. Local → always the same-origin `/media/`
	 * route. Object → a (presigned, time-limited) direct URL when possible, else the `/media/`
	 * proxy. Returns null if the ref is unsafe (traversal).
	 */
	url(ref: string): string | null;
}

/** A safe same-origin /media URL for a ref, or null if the ref escapes the media root (traversal). */
export function mediaProxyUrl(ref: string): string | null {
	return safeMediaPath(ref) ? `/media/${ref}` : null;
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

	async put(ref: string, data: Uint8Array | ReadableStream | Blob): Promise<void> {
		const abs = this.#abs(ref);
		if (!abs) throw new Error(`unsafe media ref: ${ref}`);
		await Bun.write(abs, data as Blob);
	}

	/** Local files are always served same-origin via the /media route. */
	url(ref: string): string | null {
		return mediaProxyUrl(ref);
	}
}
