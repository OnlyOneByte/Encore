// A JSON response gzipped when the client asks for it. Nothing between a route and the socket compresses
// (svelte-adapter-bun's `precompress` covers static assets only), so a big read-only body pays for its own.
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { json } from '@sveltejs/kit';

const gzipAsync = promisify(gzip);

/** Whether `Accept-Encoding` takes gzip. A `q=0` is a refusal, and a gzip entry outranks `*`. */
export function acceptsGzip(header: string | null): boolean {
	const qOf = new Map<string, number>();
	for (const part of (header ?? '').split(',')) {
		const [coding, ...params] = part.trim().toLowerCase().split(';');
		const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
		if (coding) qOf.set(coding.trim(), q === undefined ? 1 : Number(q.slice(2)));
	}
	return (qOf.get('gzip') ?? qOf.get('*') ?? 0) > 0;
}

/** `json(body)`, gzipped for a client that accepts it. Vary on both answers, so a cache never hands the
 *  compressed bytes to a client that did not ask for them. The ASYNC gzip runs on libuv's pool: a song turning
 *  ready sends every phone here at once, and ~10 ms of sync compression each would stall the socket that carries
 *  the room's taps. */
export async function gzipJson(request: Request, body: unknown): Promise<Response> {
	const vary = { vary: 'Accept-Encoding' };
	if (!acceptsGzip(request.headers.get('accept-encoding'))) return json(body, { headers: vary });
	return new Response(await gzipAsync(JSON.stringify(body)), {
		headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', ...vary }
	});
}
