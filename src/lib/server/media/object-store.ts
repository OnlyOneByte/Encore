// ObjectMediaStore — S3/MinIO-backed MediaStore for scale-out (workers on other boxes). Built on
// Bun's native S3 (Bun.S3Client), speaking to MinIO via a custom `endpoint`; the client is injected
// behind a tiny interface so the whole store unit-tests with no network or creds.
//
// BYTES TRANSIT THE CORE, BY DESIGN: `size`/`getRange` answer with ranged GETs through the
// same-origin `/media/<ref>` route — there is no presigned direct-to-S3 URL, and that member should
// not be re-added (see store.ts).

import { objectKey, type MediaStore, type ObjectStoreConfig } from './store';

/** The slice of an S3 client this store needs — Bun.S3Client satisfies it; tests pass a fake. */
export interface S3Like {
	/** Object handle exposing exists/write/stream/size/slice for a single key. */
	file(key: string): {
		exists(): Promise<boolean>;
		write(data: Uint8Array | ReadableStream | Blob): Promise<unknown>;
		stream(): ReadableStream;
		/** HEAD the object for metadata (Bun.S3File.stat) — `.size` is the byte length, no body. */
		stat(): Promise<{ size: number }>;
		/** A `Blob` over a byte window, WITHOUT downloading the whole object — a ranged GET on S3
		 *  (EXCLUSIVE end like `Blob.slice`, issued lazily). Lets the response carry `Content-Length`. */
		slice(start: number, end: number): Blob;
	};
}

export class ObjectMediaStore implements MediaStore {
	readonly kind = 'object' as const;
	#client: S3Like;
	#prefix: string | undefined;

	constructor(client: S3Like, config: Pick<ObjectStoreConfig, 'prefix'>) {
		this.#client = client;
		this.#prefix = config.prefix;
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
	 * Byte size via a HEAD (no body transferred), or null if absent — half the range capability
	 * `/media` needs; without it the route degrades to a range-less `200` and WebKit never plays.
	 */
	async size(ref: string): Promise<number | null> {
		const f = this.#client.file(this.#key(ref));
		return (await f.exists()) ? (await f.stat()).size : null;
	}

	/**
	 * INCLUSIVE byte range as a Blob via a ranged GET (no full download). `slice`'s end is EXCLUSIVE,
	 * hence `end + 1` — wrong here drops the final byte, read as a corrupt stream. Blob (not stream)
	 * so the response carries `Content-Length`.
	 */
	async getRange(ref: string, start: number, end: number): Promise<Blob | null> {
		const f = this.#client.file(this.#key(ref));
		if (!(await f.exists())) return null;
		return f.slice(start, end + 1);
	}

	async put(ref: string, data: Uint8Array | ReadableStream | Blob): Promise<void> {
		await this.#client.file(this.#key(ref)).write(data);
	}
}

/** Build the real Bun.S3Client (creds from standard AWS_* env, read automatically). Imported lazily
 *  by app.ts only when MEDIA_STORE=object, so the local default never touches the S3 client. */
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
