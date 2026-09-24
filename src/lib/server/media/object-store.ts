// S3/MinIO-backed MediaStore for scale-out. The client is injected behind a tiny interface, so the whole
// store unit-tests with no network or creds.
//
// BYTES TRANSIT THE CORE, BY DESIGN: `size`/`getRange` answer with ranged GETs through the same-origin
// `/media/<ref>` route. There is no presigned direct-to-S3 URL and that member must not be re-added.

import { objectKey, type MediaStore, type ObjectStoreConfig } from './store';

/** Bun.S3Client satisfies it; tests pass a fake. */
export interface S3Like {
	/** Object handle exposing exists/write/stream/size/slice for a single key. */
	file(key: string): {
		exists(): Promise<boolean>;
		write(data: Uint8Array | ReadableStream | Blob): Promise<unknown>;
		stream(): ReadableStream;
		/** HEAD for metadata: `.size` is the byte length, no body. */
		stat(): Promise<{ size: number }>;
		/** A ranged GET, EXCLUSIVE-end like `Blob.slice`, without downloading the whole object. A Blob, so
		 *  the response carries `Content-Length`. */
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

	/** Half the range capability `/media` needs: without it the route degrades to a range-less `200` and
	 *  WebKit never plays. */
	async size(ref: string): Promise<number | null> {
		const f = this.#client.file(this.#key(ref));
		return (await f.exists()) ? (await f.stat()).size : null;
	}

	/** INCLUSIVE, via a ranged GET. `slice`'s end is EXCLUSIVE, hence `end + 1`: wrong here drops the final
	 *  byte and reads as a corrupt stream. A Blob, so the response carries `Content-Length`. */
	async getRange(ref: string, start: number, end: number): Promise<Blob | null> {
		const f = this.#client.file(this.#key(ref));
		if (!(await f.exists())) return null;
		return f.slice(start, end + 1);
	}

	async put(ref: string, data: Uint8Array | ReadableStream | Blob): Promise<void> {
		await this.#client.file(this.#key(ref)).write(data);
	}
}

/** Imported lazily by app.ts only when MEDIA_STORE=object, so the local default never touches S3. */
export function bunS3Client(config: ObjectStoreConfig): S3Like {
	// Global in the Bun runtime; typed loosely to avoid a hard bun-types coupling.
	const S3 = (globalThis as { Bun?: { S3Client?: new (o: unknown) => S3Like } }).Bun?.S3Client;
	if (!S3) throw new Error('Bun.S3Client unavailable — object MediaStore requires the Bun runtime');
	return new S3({
		bucket: config.bucket,
		endpoint: config.endpoint,
		region: config.region
	});
}
