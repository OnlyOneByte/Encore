// ObjectMediaStore — S3/MinIO-backed MediaStore for scale-out (workers on other boxes). Built on
// Bun's native S3 (Bun.S3Client) — no aws-sdk/minio dep; speaks to MinIO via a custom `endpoint`.
// See MASTER-DESIGN §2. The S3 client is injected behind a tiny interface so the whole store
// unit-tests against an in-memory fake (no network, no creds).

import { objectKey, mediaProxyUrl, type MediaStore, type ObjectStoreConfig } from './store';

/** The slice of an S3 client this store needs — Bun.S3Client satisfies it; tests pass a fake. */
export interface S3Like {
	/** Object handle exposing exists/write/stream/size/slice + a presign for a single key. */
	file(key: string): {
		exists(): Promise<boolean>;
		write(data: Uint8Array | ReadableStream | Blob): Promise<unknown>;
		stream(): ReadableStream;
		presign(opts?: { expiresIn?: number }): string;
		/** HEAD the object for metadata (Bun.S3File.stat) — `.size` is the byte length, no body. */
		stat(): Promise<{ size: number }>;
		/**
		 * A `Blob` over a byte window, WITHOUT downloading the whole object — a ranged GET on S3
		 * (`Bun.S3File.slice(start, end)`, whose end is EXCLUSIVE like `Blob.slice`, and which issues
		 * the `Range` request lazily). A Blob body is what lets the response carry a `Content-Length`.
		 */
		slice(start: number, end: number): Blob;
	};
}

export interface ObjectMediaStoreOpts {
	/** Presigned-URL TTL handed to the TV `<video>` (default 1h — longer than any song). */
	presignExpiresIn?: number;
	/** Force the same-origin /media proxy instead of presigned URLs (e.g. private buckets). */
	proxyUrls?: boolean;
}

export class ObjectMediaStore implements MediaStore {
	readonly kind = 'object' as const;
	#client: S3Like;
	#prefix: string | undefined;
	#expiresIn: number;
	#proxyUrls: boolean;

	constructor(client: S3Like, config: Pick<ObjectStoreConfig, 'prefix'>, opts: ObjectMediaStoreOpts = {}) {
		this.#client = client;
		this.#prefix = config.prefix;
		this.#expiresIn = opts.presignExpiresIn ?? 3600;
		this.#proxyUrls = opts.proxyUrls ?? false;
	}

	#key(ref: string): string {
		return objectKey(this.#prefix, ref);
	}

	async exists(ref: string): Promise<boolean> {
		return this.#client.file(this.#key(ref)).exists();
	}

	async get(ref: string): Promise<ReadableStream | null> {
		const f = this.#client.file(this.#key(ref));
		return (await f.exists()) ? f.stream() : null;
	}

	/**
	 * Byte size via a HEAD on the object (no body transferred), or null when it is absent. This is
	 * half of the range capability the /media route needs; without it the route degrades to a
	 * range-less full 200 and WebKit never plays — see media/http-range.ts.
	 */
	async size(ref: string): Promise<number | null> {
		const f = this.#client.file(this.#key(ref));
		return (await f.exists()) ? (await f.stat()).size : null;
	}

	/**
	 * Read an INCLUSIVE byte range as a Blob backed by a ranged GET (no full download). HTTP ranges
	 * are inclusive but `slice`'s end is EXCLUSIVE — hence `end + 1`; getting that wrong drops the
	 * final byte of every chunk, which a decoder reports as a corrupt stream. Returns a Blob (not a
	 * stream) so the response carries a `Content-Length`. Null for an absent object.
	 */
	async getRange(ref: string, start: number, end: number): Promise<Blob | null> {
		const f = this.#client.file(this.#key(ref));
		if (!(await f.exists())) return null;
		return f.slice(start, end + 1);
	}

	async put(ref: string, data: Uint8Array | ReadableStream | Blob): Promise<void> {
		await this.#client.file(this.#key(ref)).write(data);
	}

	/**
	 * Object stores serve a presigned, time-limited DIRECT url by default (offloads bytes from the
	 * core — the whole point of going remote). When `proxyUrls` is set (private bucket / no CORS),
	 * fall back to the same-origin /media route, which streams via get(). Unsafe ref → null.
	 */
	url(ref: string): string | null {
		if (this.#proxyUrls) return mediaProxyUrl(ref);
		// guard the ref the same way the proxy path does, so a traversal-y ref never becomes a key
		if (mediaProxyUrl(ref) === null) return null;
		return this.#client.file(this.#key(ref)).presign({ expiresIn: this.#expiresIn });
	}
}

/**
 * Build the real Bun.S3Client for an ObjectStoreConfig (creds from the standard AWS_* env, which
 * Bun.S3Client reads automatically). Imported lazily by app.ts only when MEDIA_STORE=object, so the
 * local default never touches the S3 client. Returns an S3Like.
 */
export function bunS3Client(config: ObjectStoreConfig): S3Like {
	// Bun.S3Client is global in the Bun runtime; typed loosely to avoid a hard bun-types coupling.
	const S3 = (globalThis as { Bun?: { S3Client?: new (o: unknown) => S3Like } }).Bun?.S3Client;
	if (!S3) throw new Error('Bun.S3Client unavailable — object MediaStore requires the Bun runtime');
	return new S3({
		bucket: config.bucket,
		endpoint: config.endpoint,
		region: config.region
	});
}
